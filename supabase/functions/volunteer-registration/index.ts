import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const jsonResponse = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return "";
  const value = error as Record<string, unknown>;
  const message = typeof value.message === "string" ? value.message : "";
  const details = typeof value.details === "string" ? value.details : "";
  const hint = typeof value.hint === "string" ? value.hint : "";
  return [message, details, hint].filter(Boolean).join(" ");
}

function allowedOrigins() {
  return (Deno.env.get("APP_ALLOWED_ORIGINS") || "https://spas1-hybrid.pages.dev")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLocalDevelopmentOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const allowedVolunteerRoles = [
  "Kepala SPPG",
  "Akuntan",
  "Ahli Gizi",
  "Aslap ( Asisten Lapangan )",
  "Head Chef",
  "Koordinator Persiapan",
  "Koordinator Pemorsian",
  "Koordinator Ompreng",
  "Koordinator Security",
  "Koordinator Driver",
];
const allowedVolunteerDivisions = [
  "Koki",
  "Persiapan",
  "Pemorsian",
  "Cuci Ompreng",
  "Driver",
  "Office Boy",
  "Security / Keamanan",
];
const pendingRegistrationStatuses = [
  "Menunggu Persetujuan SUPER ADMIN",
  "Menunggu Verifikasi SUPER ADMIN",
];
const legacySppgId = "00000000-0000-4000-8000-000000000001";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function verifyTurnstileToken(
  token: string,
  request: Request,
  origin: string,
): Promise<{ error: string; status: number } | null> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return { error: "Verifikasi keamanan belum dikonfigurasi. Hubungi pengelola aplikasi.", status: 503 };
  if (!token) return { error: "Selesaikan verifikasi keamanan terlebih dahulu.", status: 400 };

  const body = new URLSearchParams({ secret, response: token });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.set("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Verifikasi Cloudflare gagal dijangkau.");
  const verification = await response.json() as { success?: boolean; hostname?: string };
  const originHostname = new URL(origin).hostname;
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const testMode = Deno.env.get("TURNSTILE_TEST_MODE") === "true";
  if (testMode && !localHosts.has(originHostname)) {
    return { error: "Mode uji Turnstile hanya boleh dipakai dari aplikasi lokal.", status: 403 };
  }
  const expectedHostname = testMode ? "example.com" : originHostname;
  if (verification.success !== true || verification.hostname !== expectedHostname) {
    return { error: "Verifikasi keamanan gagal atau sudah kedaluwarsa. Silakan coba lagi.", status: 400 };
  }
  return null;
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get("Origin") || "";
  const origins = allowedOrigins();
  const originAllowed = origins.includes(originHeader) || isLocalDevelopmentOrigin(originHeader);
  const origin = originAllowed ? originHeader : origins[0];

  if (request.method === "OPTIONS") {
    if (!originAllowed) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);
  if (!originHeader || !originAllowed) {
    return jsonResponse({ error: "Origin is not allowed." }, 403, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Server authentication is not configured." }, 500, origin);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request." }, 400, origin);
  }

  let adminAuthorized = false;
  try {
    if (input.action === "submit") {
      return await submitRegistration(input, request, adminClient, origin);
    }
    if (input.action === "submitOrganizationRequest") {
      return await submitOrganizationRequest(input, request, adminClient, origin);
    }

    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return jsonResponse({ error: "Login diperlukan." }, 401, origin);
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) return jsonResponse({ error: "Sesi login tidak valid." }, 401, origin);
    if (input.action === "listOrganizationRequests" || input.action === "reviewOrganizationRequest") {
      if (user.app_metadata?.platform_admin !== true) {
        return jsonResponse({ error: "Aksi hanya tersedia untuk admin platform." }, 403, origin);
      }
      adminAuthorized = true;
      if (input.action === "listOrganizationRequests") return await listOrganizationRequests(adminClient, origin);
      return await reviewOrganizationRequest(input, user.id, adminClient, origin);
    }
    const { data: membership, error: membershipError } = await adminClient
      .from("spas1_memberships")
      .select("sppg_id,member_role,status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || membership.status !== "active" || !uuidPattern.test(membership.sppg_id)) {
      return jsonResponse({ error: "Keanggotaan SPPG tidak aktif." }, 403, origin);
    }
    const sppgId = membership.sppg_id;
    const claimedSppgId = String(user.app_metadata?.sppg_id || "");
    if (!uuidPattern.test(claimedSppgId) || claimedSppgId.toLowerCase() !== sppgId.toLowerCase()) {
      return jsonResponse({ error: "Identitas SPPG pada sesi login tidak sesuai." }, 403, origin);
    }

    if (input.action === "attendance") {
      if (membership.member_role !== "employee" || user.app_metadata?.role !== "employee") {
        return jsonResponse({ error: "Aksi absensi hanya tersedia untuk akun relawan." }, 403, origin);
      }
      return await recordAttendance(input, user.id, sppgId, adminClient, origin);
    }
    if (user.app_metadata?.role !== "admin" || membership.member_role !== "admin") {
      return jsonResponse({ error: "Hanya SUPER ADMIN yang dapat mengelola permohonan." }, 403, origin);
    }
    adminAuthorized = true;
    if (input.action === "list") return await listRegistrations(sppgId, adminClient, origin);
    if (input.action === "review") return await reviewRegistration(input, user.id, sppgId, adminClient, origin);
    if (input.action === "updateRequest") return await updateRegistration(input, sppgId, adminClient, origin);
    if (input.action === "deleteRequest") return await deleteRegistration(input, sppgId, adminClient, origin);
    return jsonResponse({ error: "Aksi tidak dikenal." }, 400, origin);
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("Volunteer function failed:", message || "Unknown error");
    return jsonResponse({
      error: adminAuthorized && message ? message : "Permintaan gagal.",
    }, 500, origin);
  }
});

async function submitRegistration(
  input: Record<string, unknown>,
  request: Request,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const sppgId = String(input.sppgId || legacySppgId);
  if (!uuidPattern.test(sppgId)) {
    return jsonResponse({ error: "Identitas SPPG tidak valid." }, 400, origin);
  }
  const { data: organization, error: organizationError } = await adminClient
    .from("spas1_organizations")
    .select("id")
    .eq("id", sppgId)
    .eq("status", "active")
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) return jsonResponse({ error: "SPPG tujuan tidak ditemukan atau belum aktif." }, 404, origin);

  const name = String(input.nama || "").trim();
  const volunteerId = String(input.idRelawan || "").trim();
  const contactEmail = String(input.email || "").trim().toLowerCase();
  const phone = String(input.noHp || "").trim();
  const role = String(input.role || "").trim();
  const division = String(input.division || "").trim();
  const password = String(input.pin || "");
  const confirmation = String(input.pinConfirm || "");
  if (!name || name.length > 150 || !volunteerId || volunteerId.length > 80 ||
      !/^[A-Za-z0-9._-]+$/.test(volunteerId) ||
      contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ||
      !phone || phone.length > 40 || !allowedVolunteerRoles.includes(role) ||
      !allowedVolunteerDivisions.includes(division) || password.length < 8 || password.length > 128 ||
      password !== confirmation) {
    return jsonResponse({ error: "Data pendaftaran tidak valid. Periksa ID, email, nomor HP, dan PIN minimal 8 karakter." }, 400, origin);
  }

  const turnstileToken = String(input.turnstileToken || "");
  const verificationError = await verifyTurnstileToken(turnstileToken, request, origin);
  if (verificationError) return jsonResponse({ error: verificationError.error }, verificationError.status, origin);

  const authEmail = `${volunteerId}@relawan.spas1.local`.toLowerCase();
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: false,
    user_metadata: { id_relawan: volunteerId, contact_email: contactEmail },
  });
  if (createError || !created.user) {
    return jsonResponse({ error: createError?.message || "Akun relawan tidak dapat dibuat." }, 409, origin);
  }

  const { error: metadataError } = await adminClient.auth.admin.updateUserById(created.user.id, {
    app_metadata: { role: "employee", id_relawan: volunteerId, sppg_id: sppgId },
  });
  if (metadataError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (cleanupError) throw new Error("Identitas akun gagal diperbarui dan akun sementara gagal dibersihkan.");
    throw metadataError;
  }

  const { error: membershipError } = await adminClient.from("spas1_memberships").insert({
    user_id: created.user.id,
    sppg_id: sppgId,
    member_role: "employee",
    status: "suspended",
  });
  if (membershipError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (cleanupError) throw new Error("Keanggotaan SPPG gagal dibuat dan akun sementara gagal dibersihkan.");
    throw membershipError;
  }

  const requestId = `REG-${crypto.randomUUID()}`;
  const { error: insertError } = await adminClient.from("MODUL1_PendaftaranRelawan").insert({
    "ID Permohonan": requestId,
    sppg_id: sppgId,
    "ID Relawan": volunteerId,
    "Auth User ID": created.user.id,
    "Nama Lengkap": name,
    Email: contactEmail,
    "No HP": phone,
    Role: role,
    Divisi: division,
    Status: "Menunggu Persetujuan SUPER ADMIN",
    "Diajukan Pada": new Date().toISOString(),
  });
  if (insertError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (cleanupError) throw new Error("Permohonan gagal disimpan dan akun sementara gagal dibersihkan.");
    if (insertError.code === "23505") {
      return jsonResponse({ error: "ID Relawan ini sudah terdaftar atau sedang menunggu persetujuan." }, 409, origin);
    }
    throw insertError;
  }
  return jsonResponse({ status: "success", message: "Pendaftaran terkirim. Akun dapat digunakan setelah disetujui SUPER ADMIN." }, 200, origin);
}

async function submitOrganizationRequest(
  input: Record<string, unknown>,
  request: Request,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const name = String(input.name || "").trim();
  const slug = String(input.slug || "").trim().toLowerCase();
  const contactName = String(input.contactName || "").trim();
  const contactEmail = String(input.contactEmail || "").trim().toLowerCase();
  const contactPhone = String(input.contactPhone || "").trim();
  if (name.length < 3 || name.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      slug.length > 63 || contactName.length < 2 || contactName.length > 150 ||
      contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ||
      contactPhone.length < 5 || contactPhone.length > 40) {
    return jsonResponse({ error: "Periksa nama SPPG, alamat slug, nama pemohon, email, dan nomor HP." }, 400, origin);
  }
  const verificationError = await verifyTurnstileToken(String(input.turnstileToken || ""), request, origin);
  if (verificationError) return jsonResponse({ error: verificationError.error }, verificationError.status, origin);

  const { data, error } = await adminClient
    .from("spas1_organization_requests")
    .insert({
      slug,
      name,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
    })
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") {
    return jsonResponse({ error: "Nama alamat SPPG tersebut sedang digunakan atau masih menunggu pemeriksaan." }, 409, origin);
  }
  if (error) throw error;
  if (!data) throw new Error("Permohonan SPPG tidak berhasil disimpan.");
  return jsonResponse({
    status: "success",
    message: "Permohonan SPPG terkirim. Jika disetujui, undangan untuk admin pertama akan dikirim ke email yang dicantumkan.",
  }, 200, origin);
}

async function listOrganizationRequests(
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const { data, error } = await adminClient
    .from("spas1_organization_requests")
    .select("id,slug,name,contact_name,contact_email,contact_phone,created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return jsonResponse({ status: "success", requests: data || [] }, 200, origin);
}

async function reviewOrganizationRequest(
  input: Record<string, unknown>,
  adminId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const requestId = String(input.requestId || "");
  const decision = String(input.decision || "");
  if (!uuidPattern.test(requestId) || !["approve", "reject"].includes(decision)) {
    return jsonResponse({ error: "Permohonan atau keputusan tidak valid." }, 400, origin);
  }

  if (decision === "reject") {
    const { data, error } = await adminClient
      .from("spas1_organization_requests")
      .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: adminId })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: "Permohonan tidak ditemukan atau sudah diproses." }, 409, origin);
    return jsonResponse({ status: "success", message: "Permohonan SPPG ditolak." }, 200, origin);
  }

  const { data: requestRow, error: claimError } = await adminClient
    .from("spas1_organization_requests")
    .update({ status: "processing" })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id,slug,name,contact_name,contact_email")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!requestRow) return jsonResponse({ error: "Permohonan tidak ditemukan atau sudah diproses." }, 409, origin);

  const organizationId = crypto.randomUUID();
  let organizationCreated = false;
  let invitedUserId: string | null = null;
  try {
    const { data: existingOrganization, error: existingOrganizationError } = await adminClient
      .from("spas1_organizations")
      .select("id")
      .eq("slug", requestRow.slug)
      .maybeSingle();
    if (existingOrganizationError) throw existingOrganizationError;
    if (existingOrganization) throw new Error("Alamat SPPG ini sudah digunakan oleh organisasi lain.");

    const { error: organizationError } = await adminClient.from("spas1_organizations").insert({
      id: organizationId,
      slug: requestRow.slug,
      name: requestRow.name,
      status: "active",
    });
    if (organizationError) throw organizationError;
    organizationCreated = true;

    const { data: invitation, error: invitationError } = await adminClient.auth.admin.inviteUserByEmail(
      requestRow.contact_email,
      { data: { full_name: requestRow.contact_name } },
    );
    if (invitation.user) invitedUserId = invitation.user.id;
    if (invitationError || !invitation.user) {
      throw invitationError || new Error("Undangan email admin pertama tidak berhasil dibuat.");
    }

    const { error: metadataError } = await adminClient.auth.admin.updateUserById(invitedUserId, {
      app_metadata: { role: "admin", sppg_id: organizationId },
    });
    if (metadataError) throw metadataError;

    const { error: membershipError } = await adminClient.from("spas1_memberships").insert({
      user_id: invitedUserId,
      sppg_id: organizationId,
      member_role: "admin",
      status: "active",
    });
    if (membershipError) throw membershipError;

    const { data: approvedRequest, error: approvalError } = await adminClient
      .from("spas1_organization_requests")
      .update({
        status: "approved",
        decided_at: new Date().toISOString(),
        decided_by: adminId,
        organization_id: organizationId,
      })
      .eq("id", requestId)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (approvalError) throw approvalError;
    if (!approvedRequest) throw new Error("Status permohonan berubah sebelum persetujuan selesai.");
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (invitedUserId) {
      const { error: cleanupError } = await adminClient.auth.admin.deleteUser(invitedUserId);
      if (cleanupError) cleanupErrors.push("akun undangan");
    }
    if (organizationCreated) {
      const { error: cleanupError } = await adminClient
        .from("spas1_organizations")
        .delete()
        .eq("id", organizationId);
      if (cleanupError) cleanupErrors.push("organisasi");
    }
    const { error: restoreError } = await adminClient
      .from("spas1_organization_requests")
      .update({ status: "pending" })
      .eq("id", requestId)
      .eq("status", "processing");
    if (restoreError) cleanupErrors.push("status permohonan");
    if (cleanupErrors.length) {
      throw new Error("Persetujuan gagal; pemulihan " + cleanupErrors.join(", ") + " juga gagal. Periksa data sebelum mencoba lagi.");
    }
    throw error;
  }
  return jsonResponse({
    status: "success",
    message: "SPPG aktif dan undangan admin pertama telah dikirim ke " + requestRow.contact_email + ".",
  }, 200, origin);
}

async function listRegistrations(
  sppgId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const { data, error } = await adminClient
    .from("MODUL1_PendaftaranRelawan")
    .select('"ID Permohonan","ID Relawan","Nama Lengkap",Email,"No HP",Role,Divisi,Status,"Diajukan Pada"')
    .eq("sppg_id", sppgId)
    .order("Diajukan Pada", { ascending: false });
  if (error) throw error;
  const registrations = (data || []).map((row) => ({
    requestId: row["ID Permohonan"],
    idRelawan: row["ID Relawan"],
    nama: row["Nama Lengkap"],
    email: row.Email,
    noHp: row["No HP"],
    role: row.Role || "",
    division: row.Divisi || "",
    status: row.Status,
    submittedAt: row["Diajukan Pada"],
  }));
  return jsonResponse({
    status: "success",
    registrations,
    pendingCount: registrations.filter((item) => item.status === "Menunggu Persetujuan SUPER ADMIN").length,
  }, 200, origin);
}

async function reviewRegistration(
  input: Record<string, unknown>,
  adminId: string,
  sppgId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const requestId = String(input.requestId || "");
  const decision = input.decision;
  if (!requestId || !["approve", "reject"].includes(String(decision))) {
    return jsonResponse({ error: "Keputusan atau ID permohonan tidak valid." }, 400, origin);
  }
  const processingStatus = "Sedang Diproses";
  const { data: requestRow, error: claimError } = await adminClient
    .from("MODUL1_PendaftaranRelawan")
    .update({ Status: processingStatus })
    .eq("sppg_id", sppgId)
    .eq("ID Permohonan", requestId)
    .in("Status", pendingRegistrationStatuses)
    .select('*')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!requestRow) {
    return jsonResponse({ error: "Permohonan tidak ditemukan atau sudah diproses." }, 409, origin);
  }

  const authUserId = requestRow["Auth User ID"];
  const status = decision === "approve" ? "Disetujui" : "Ditolak";
  let profileCreated = false;
  try {
    if (!authUserId) throw new Error("ID akun Auth pada permohonan tidak tersedia.");

    if (decision === "approve") {
      const { error: profileError } = await adminClient.from("MODUL1_DataRelawan").insert({
        sppg_id: sppgId,
        "ID Relawan": requestRow["ID Relawan"],
        "Auth User ID": authUserId,
        "Nama Lengkap": requestRow["Nama Lengkap"],
        Divisi: requestRow.Divisi || "Relawan",
        Role: requestRow.Role || "Relawan",
        "Status Biometrik": "Belum diverifikasi",
        "No HP": requestRow["No HP"],
        "Status Akun": "Aktif",
      });
      if (profileError) throw profileError;
      profileCreated = true;
      const { data: membership, error: membershipError } = await adminClient
        .from("spas1_memberships")
        .update({ status: "active" })
        .eq("user_id", authUserId)
        .eq("sppg_id", sppgId)
        .eq("status", "suspended")
        .select("user_id")
        .maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) throw new Error("Keanggotaan SPPG relawan tidak ditemukan atau sudah berubah.");
    }

    const { data: updatedRequest, error: requestError } = await adminClient
      .from("MODUL1_PendaftaranRelawan")
      .update({
        Status: status,
        "Diputuskan Pada": new Date().toISOString(),
        "Diputuskan Oleh": adminId,
      })
      .eq("sppg_id", sppgId)
      .eq("ID Permohonan", requestId)
      .eq("Status", processingStatus)
      .select('"ID Permohonan"')
      .maybeSingle();
    if (requestError) throw requestError;
    if (!updatedRequest) throw new Error("Permohonan berubah saat sedang diproses.");

    if (decision === "approve") {
      const { error: authError } = await adminClient.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
      });
      if (authError) throw authError;
    } else {
      const { error: deleteError } = await adminClient.auth.admin.deleteUser(authUserId);
      if (deleteError) throw deleteError;
    }
  } catch (error) {
    const { error: rollbackError } = await adminClient
      .from("MODUL1_PendaftaranRelawan")
      .update({
        Status: pendingRegistrationStatuses[0],
        "Diputuskan Pada": null,
        "Diputuskan Oleh": null,
      })
      .eq("sppg_id", sppgId)
      .eq("ID Permohonan", requestId);
    let profileRollbackError: Error | null = null;
    let membershipRollbackError: Error | null = null;
    if (profileCreated) {
      const { error } = await adminClient
        .from("MODUL1_DataRelawan")
        .delete()
        .eq("sppg_id", sppgId)
        .eq("Auth User ID", authUserId);
      profileRollbackError = error;
      const { error: membershipError } = await adminClient
        .from("spas1_memberships")
        .update({ status: "suspended" })
        .eq("user_id", authUserId)
        .eq("sppg_id", sppgId);
      membershipRollbackError = membershipError;
    }
    if (rollbackError || profileRollbackError || membershipRollbackError) {
      throw new Error("Proses gagal dan pemulihan data juga gagal. Periksa permohonan di Supabase sebelum mencoba lagi.");
    }
    throw error;
  }
  return jsonResponse({ status: "success", message: `Permohonan berhasil ${decision === "approve" ? "disetujui" : "ditolak"}.` }, 200, origin);
}

async function updateRegistration(
  input: Record<string, unknown>,
  sppgId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const requestId = String(input.requestId || "").trim();
  const name = String(input.nama || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.noHp || "").trim();
  const role = String(input.role || "").trim();
  const division = String(input.division || "").trim();
  if (!requestId || !name || name.length > 150 ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !phone || phone.length > 40 || !allowedVolunteerRoles.includes(role) ||
      !allowedVolunteerDivisions.includes(division)) {
    return jsonResponse({ error: "Data permohonan tidak valid. Periksa nama, email, nomor HP, Role, dan Divisi." }, 400, origin);
  }
  const { data, error } = await adminClient
    .from("MODUL1_PendaftaranRelawan")
    .update({
      "Nama Lengkap": name,
      Email: email,
      "No HP": phone,
      Role: role,
      Divisi: division,
    })
    .eq("sppg_id", sppgId)
    .eq("ID Permohonan", requestId)
    .in("Status", pendingRegistrationStatuses)
    .select('"ID Permohonan"')
    .maybeSingle();
  if (error) throw error;
  if (!data) return jsonResponse({ error: "Permohonan tidak ditemukan atau sudah diproses; hanya permohonan menunggu yang dapat diubah." }, 409, origin);
  return jsonResponse({ status: "success", message: "Perubahan permohonan berhasil disimpan." }, 200, origin);
}

async function deleteRegistration(
  input: Record<string, unknown>,
  sppgId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const requestId = String(input.requestId || "").trim();
  if (!requestId) return jsonResponse({ error: "ID permohonan tidak ditemukan." }, 400, origin);
  const deletingStatus = "Dihapus";
  const { data: requestRow, error: claimError } = await adminClient
    .from("MODUL1_PendaftaranRelawan")
    .update({ Status: deletingStatus })
    .eq("sppg_id", sppgId)
    .eq("ID Permohonan", requestId)
    .in("Status", pendingRegistrationStatuses)
    .select('"ID Permohonan","Auth User ID"')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!requestRow) return jsonResponse({ error: "Permohonan tidak ditemukan atau sudah diproses; hanya permohonan menunggu yang dapat dihapus." }, 409, origin);

  const authUserId = requestRow["Auth User ID"];
  if (authUserId) {
    const { error: authError } = await adminClient.auth.admin.deleteUser(authUserId);
    if (authError) {
      const { error: restoreError } = await adminClient
        .from("MODUL1_PendaftaranRelawan")
        .update({ Status: pendingRegistrationStatuses[0] })
        .eq("sppg_id", sppgId)
        .eq("ID Permohonan", requestId)
        .eq("Status", deletingStatus);
      if (restoreError) throw new Error("Akun tidak dapat dihapus dan status permohonan gagal dipulihkan.");
      throw authError;
    }
  }

  const { data: deletedRequest, error: deleteError } = await adminClient
    .from("MODUL1_PendaftaranRelawan")
    .delete()
    .eq("sppg_id", sppgId)
    .eq("ID Permohonan", requestId)
    .eq("Status", deletingStatus)
    .select('"ID Permohonan"')
    .maybeSingle();
  if (deleteError || !deletedRequest) {
    const { data: restoredRequest, error: restoreError } = await adminClient
      .from("MODUL1_PendaftaranRelawan")
      .update({ Status: pendingRegistrationStatuses[0], "Auth User ID": null })
      .eq("sppg_id", sppgId)
      .eq("ID Permohonan", requestId)
      .eq("Status", deletingStatus)
      .select('"ID Permohonan"')
      .maybeSingle();
    if (restoreError || !restoredRequest) {
      throw new Error("Akun login sudah dihapus, tetapi permohonan gagal dibersihkan atau dipulihkan. Periksa data di Supabase.");
    }
    throw new Error("Akun login sudah dihapus. Permohonan masih tercatat tanpa akun; klik Hapus lagi untuk membersihkannya." +
      (deleteError ? " " + deleteError.message : ""));
  }
  return jsonResponse({ status: "success", message: "Permohonan dan akun login terkait berhasil dihapus." }, 200, origin);
}

async function recordAttendance(
  input: Record<string, unknown>,
  authUserId: string,
  sppgId: string,
  adminClient: ReturnType<typeof createClient>,
  origin: string,
) {
  const attendanceType = String(input.tipe || "");
  if (!["Masuk", "Pulang"].includes(attendanceType)) {
    return jsonResponse({ error: "Jenis absensi tidak valid." }, 400, origin);
  }
  const { data: volunteer, error: profileError } = await adminClient
    .from("MODUL1_DataRelawan")
    .select('"ID Relawan","Nama Lengkap",Divisi,"Status Akun",sppg_id')
    .eq("sppg_id", sppgId)
    .eq("Auth User ID", authUserId)
    .eq("Status Akun", "Aktif")
    .maybeSingle();
  if (profileError) throw profileError;
  if (!volunteer) return jsonResponse({ error: "Akun relawan belum aktif atau tidak memiliki profil." }, 403, origin);

  const location = String(input.lokasi || "").slice(0, 200);
  const { error: insertError } = await adminClient.from("MODUL1_Absensi").insert({
    sppg_id: volunteer.sppg_id,
    Timestamp: new Date().toISOString(),
    "ID Karyawan": volunteer["ID Relawan"],
    Nama: volunteer["Nama Lengkap"],
    Divisi: volunteer.Divisi || "Relawan",
    "Tipe Absen": attendanceType,
    Jam: new Date().toLocaleTimeString("id-ID"),
    Lokasi: location || "Lokasi tidak tersedia",
    "Status Face": "Tidak diverifikasi",
  });
  if (insertError) throw insertError;
  return jsonResponse({ status: "success", message: "Absensi berhasil disimpan ke Supabase." }, 200, origin);
}
