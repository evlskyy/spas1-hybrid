import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const moduleNames = ["stok", "bank_menu", "persiapan"] as const;
type ModuleName = (typeof moduleNames)[number];

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

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function allowedOrigins() {
  const configured = Deno.env.get("APP_ALLOWED_ORIGINS") ||
    "https://spas1-hybrid.pages.dev";
  const origins = configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : ["https://spas1-hybrid.pages.dev"];
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

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModules(value: unknown): ModuleName[] {
  if (!Array.isArray(value)) throw new RequestError("Pilih hak akses modul.", 400);
  const selected = [...new Set(value.map(text))];
  if (selected.some((module) => !moduleNames.includes(module as ModuleName))) {
    throw new RequestError("Pilihan modul tidak valid.", 400);
  }
  return selected as ModuleName[];
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
  if (Number(request.headers.get("content-length") || 0) > 16000) {
    return jsonResponse({ error: "Permintaan terlalu besar." }, 413, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Server authentication is not configured." }, 500, origin);
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request." }, 400, origin);
  }

  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "Login diperlukan." }, 401, origin);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  try {
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) throw new RequestError("Sesi login tidak valid.", 401);

    const { data: membership, error: membershipError } = await adminClient
      .from("spas1_memberships")
      .select("sppg_id,member_role,status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || membership.status !== "active") {
      throw new RequestError("Keanggotaan SPPG tidak aktif.", 403);
    }

    const sppgId = String(membership.sppg_id);
    if (String(user.app_metadata?.sppg_id || "").toLowerCase() !== sppgId.toLowerCase()) {
      throw new RequestError("Identitas SPPG pada sesi login tidak sesuai.", 403);
    }

    if (input.action === "verifyLogin") {
      const requestedModule = text(input.module);
      if (!moduleNames.includes(requestedModule as ModuleName)) {
        throw new RequestError("Modul yang diminta tidak valid.", 400);
      }
      if (user.app_metadata?.role === "admin" && membership.member_role === "admin") {
        return jsonResponse({ status: "success" }, 200, origin);
      }
      if (user.app_metadata?.role !== "module" || membership.member_role !== "module") {
        throw new RequestError("Akun tidak memiliki akses modul.", 403);
      }

      const { data: account, error: accountError } = await adminClient
        .from("spas1_module_accounts")
        .select("employee_id,module_access,status")
        .eq("user_id", user.id)
        .eq("sppg_id", sppgId)
        .maybeSingle();
      if (accountError) throw accountError;
      if (!account || account.status !== "active" ||
          !Array.isArray(account.module_access) ||
          !account.module_access.includes(requestedModule)) {
        throw new RequestError("Akun belum diberi akses ke modul ini. Hubungi SUPER ADMIN.", 403);
      }

      const { data: employee, error: employeeError } = await adminClient
        .from("MODUL1_DataRelawan")
        .select('"ID Relawan","Status Akun"')
        .eq("sppg_id", sppgId)
        .eq('"ID Relawan"', account.employee_id)
        .maybeSingle();
      if (employeeError) throw employeeError;
      if (!employee || employee["Status Akun"] !== "Aktif") {
        throw new RequestError("Akun relawan tidak aktif. Hubungi SUPER ADMIN.", 403);
      }
      return jsonResponse({ status: "success" }, 200, origin);
    }

    if (user.app_metadata?.role !== "admin" || membership.member_role !== "admin") {
      throw new RequestError("Hanya SUPER ADMIN yang dapat mengelola akun modul.", 403);
    }

    if (input.action === "list") {
      const [{ data: employees, error: employeeError }, { data: accounts, error: accountError }] =
        await Promise.all([
          adminClient.from("MODUL1_DataRelawan")
            .select('"ID Relawan","Nama Lengkap","Status Akun"')
            .eq("sppg_id", sppgId)
            .order('"Nama Lengkap"', { ascending: true }),
          adminClient.from("spas1_module_accounts")
            .select("user_id,employee_id,username,module_access,status")
            .eq("sppg_id", sppgId)
            .order("username", { ascending: true }),
        ]);
      if (employeeError) throw employeeError;
      if (accountError) throw accountError;
      return jsonResponse({
        status: "success",
        employees: employees || [],
        accounts: accounts || [],
      }, 200, origin);
    }

    if (input.action !== "save") throw new RequestError("Aksi tidak dikenal.", 400);

    const employeeId = text(input.employeeId);
    const username = text(input.username).toLowerCase();
    const password = typeof input.password === "string" ? input.password : "";
    if (typeof input.active !== "boolean" ||
        (input.password !== undefined && typeof input.password !== "string")) {
      throw new RequestError("Status akun atau format password tidak valid.", 400);
    }
    const active = input.active;
    const modules = normalizeModules(input.moduleAccess);
    if (!employeeId || employeeId.length > 80 ||
        !/^[a-z0-9._-]{3,48}$/.test(username) ||
        password.length > 128 ||
        (password && password.length < 8) ||
        (active && modules.length === 0)) {
      throw new RequestError("Periksa ID relawan, username, password minimal 8 karakter, dan akses modul.", 400);
    }

    const { data: employee, error: employeeError } = await adminClient
      .from("MODUL1_DataRelawan")
      .select('"ID Relawan","Nama Lengkap","Status Akun"')
      .eq("sppg_id", sppgId)
      .eq('"ID Relawan"', employeeId)
      .maybeSingle();
    if (employeeError) throw employeeError;
    if (!employee) throw new RequestError("Data relawan tidak ditemukan pada SPPG ini.", 404);
    if (active && employee["Status Akun"] !== "Aktif") {
      throw new RequestError("Aktifkan akun relawan terlebih dahulu sebelum memberikan akses modul.", 409);
    }

    const { data: existing, error: existingError } = await adminClient
      .from("spas1_module_accounts")
      .select("user_id,username")
      .eq("sppg_id", sppgId)
      .eq("employee_id", employeeId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.username !== username) {
      throw new RequestError("Username akun yang sudah dibuat tidak dapat diubah.", 409);
    }
    if (!existing && !password) {
      throw new RequestError("Masukkan password awal minimal 8 karakter.", 400);
    }

    const email = `${username}@module.spas1.local`;
    const appMetadata = {
      role: "module",
      sppg_id: sppgId,
      employee_id: employeeId,
      module_access: active ? modules : [],
      module_account_active: active,
    };

    if (existing) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(
        existing.user_id,
        {
          ...(password ? { password } : {}),
          app_metadata: appMetadata,
        },
      );
      if (authUpdateError) throw authUpdateError;

      const { error: membershipUpdateError } = await adminClient
        .from("spas1_memberships")
        .upsert({
          user_id: existing.user_id,
          sppg_id: sppgId,
          member_role: "module",
          status: active ? "active" : "suspended",
        }, { onConflict: "user_id" });
      if (membershipUpdateError) throw membershipUpdateError;

      const { error: accountUpdateError } = await adminClient
        .from("spas1_module_accounts")
        .update({
          module_access: modules,
          status: active ? "active" : "suspended",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", existing.user_id)
        .eq("sppg_id", sppgId);
      if (accountUpdateError) throw accountUpdateError;
    } else {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: appMetadata,
        user_metadata: { employee_id: employeeId, display_name: employee["Nama Lengkap"] },
      });
      if (createError) {
        if (createError.code === "user_already_exists" || /already exists|already registered/i.test(createError.message)) {
          throw new RequestError("Username sudah dipakai. Pilih username lain.", 409);
        }
        throw createError;
      }
      if (!created.user) throw new Error("Supabase Auth did not return the created user.");

      try {
        const { error: membershipInsertError } = await adminClient
          .from("spas1_memberships")
          .upsert({
            user_id: created.user.id,
            sppg_id: sppgId,
            member_role: "module",
            status: active ? "active" : "suspended",
          }, { onConflict: "user_id" });
        if (membershipInsertError) throw membershipInsertError;

        const { error: accountInsertError } = await adminClient
          .from("spas1_module_accounts")
          .insert({
            user_id: created.user.id,
            sppg_id: sppgId,
            employee_id: employeeId,
            username,
            module_access: modules,
            status: active ? "active" : "suspended",
          });
        if (accountInsertError) throw accountInsertError;
      } catch (error) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw error;
      }
    }

    return jsonResponse({
      status: "success",
      message: existing ? "Akun modul berhasil diperbarui." : "Akun modul berhasil dibuat.",
    }, 200, origin);
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse({ error: error.message }, error.status, origin);
    }
    console.error("Module account request failed:", error);
    return jsonResponse({ error: "Permintaan akun modul gagal diproses." }, 500, origin);
  }
});
