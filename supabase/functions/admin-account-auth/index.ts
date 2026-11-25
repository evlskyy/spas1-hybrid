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

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function allowedOrigins() {
  const configured = Deno.env.get("APP_ALLOWED_ORIGINS") ||
    "https://spas1-hybrid.pages.dev,https://spas1.my.id";
  const origins = configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : ["https://spas1-hybrid.pages.dev", "https://spas1.my.id"];
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

async function hashLoginKey(value: string) {
  const bytes = new TextEncoder().encode(value.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (Number(request.headers.get("content-length") || 0) > 4000) {
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

  const action = text(input.action);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (action === "login") {
    const identity = text(input.username);
    const password = typeof input.password === "string" ? input.password : "";
    if (!identity || identity.length > 254 || !password || password.length > 128) {
      return jsonResponse({ error: "Username/email atau password tidak valid." }, 400, origin);
    }

    try {
      let email = identity.toLowerCase();
      let userId = "";
      if (!identity.includes("@")) {
        const username = identity.toLowerCase();
        if (!/^[a-z0-9._-]{3,48}$/.test(username)) {
          throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
        }
        const { data: account, error: accountError } = await adminClient
          .from("spas1_admin_usernames")
          .select("user_id")
          .eq("username", username)
          .maybeSingle();
        if (accountError) throw accountError;
        if (!account) {
          throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
        }
        userId = account.user_id;
        const { data: result, error: userError } = await adminClient.auth.admin.getUserById(account.user_id);
        if (userError) throw userError;
        if (!result.user || result.user.app_metadata?.role !== "admin" || !result.user.email) {
          throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
        }
        email = result.user.email;
      } else {
        const { data: resolvedUserId, error: resolveError } = await adminClient.rpc(
          "spas1_admin_login_resolve_email",
          { p_email: identity },
        );
        if (resolveError) throw resolveError;
        if (!resolvedUserId) {
          throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
        }
        userId = String(resolvedUserId);
      }

      const loginKeyHash = await hashLoginKey(userId);
      const { data: isLocked, error: throttleError } = await adminClient.rpc(
        "spas1_admin_login_is_locked",
        { p_login_key_hash: loginKeyHash },
      );
      if (throttleError) throw throttleError;
      if (isLocked) {
        throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
      }
      const recordFailedAttempt = async () => {
        const { error } = await adminClient.rpc("spas1_admin_login_record_failure", {
          p_login_key_hash: loginKeyHash,
        });
        if (error) throw error;
      };

      const authClient = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await authClient.auth.signInWithPassword({ email, password });
      if (error || !data.user || !data.session || data.user.app_metadata?.role !== "admin") {
        await recordFailedAttempt();
        throw new RequestError("Login gagal. Periksa username/email dan password.", 401);
      }
      const { error: clearError } = await adminClient.rpc("spas1_admin_login_clear", {
        p_login_key_hash: loginKeyHash,
      });
      if (clearError) throw clearError;
      return jsonResponse({
        status: "success",
        session: data.session,
      }, 200, origin);
    } catch (error) {
      if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status, origin);
      console.error("Admin login request failed:", error);
      return jsonResponse({ error: "Login admin gagal diproses." }, 500, origin);
    }
  }

  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "Login diperlukan." }, 401, origin);
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  try {
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user || user.app_metadata?.role !== "admin") {
      throw new RequestError("Sesi SUPER ADMIN tidak valid.", 403);
    }

    if (action === "profile") {
      const { data: account, error } = await adminClient
        .from("spas1_admin_usernames")
        .select("username")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      return jsonResponse({
        status: "success",
        username: account?.username || "",
        recoveryEmail: user.email || "",
        recoveryEmailVerified: Boolean(user.email_confirmed_at),
        recoveryEmailIsSynthetic: Boolean(user.email?.toLowerCase().endsWith("@admin.spas1.local")),
      }, 200, origin);
    }

    if (action === "set-username") {
      const username = text(input.username).toLowerCase();
      if (!/^[a-z0-9._-]{3,48}$/.test(username)) {
        throw new RequestError("Username harus 3–48 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.", 400);
      }
      const { error } = await adminClient
        .from("spas1_admin_usernames")
        .upsert({
          user_id: user.id,
          username,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      if (error?.code === "23505") {
        throw new RequestError("Username sudah digunakan. Pilih username lain.", 409);
      }
      if (error) throw error;
      return jsonResponse({
        status: "success",
        message: "Username diperbarui. Email pemulihan tidak berubah.",
      }, 200, origin);
    }

    if (action === "set-recovery-email") {
      const email = text(input.email).toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.endsWith("@admin.spas1.local")) {
        throw new RequestError("Masukkan email aktif yang dapat menerima pesan verifikasi.", 400);
      }
      if (user.email?.toLowerCase().endsWith("@admin.spas1.local")) {
        throw new RequestError(
          "Email akun ini masih alamat internal. Hubungi pengelola untuk verifikasi kepemilikan dan pembaruan email pemulihan.",
          409,
        );
      }
      if (!user.email_confirmed_at) {
        throw new RequestError(
          "Email akun saat ini belum terverifikasi. Hubungi pengelola untuk memverifikasi kepemilikan akun.",
          409,
        );
      }
      const emailResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      if (!emailResponse.ok) {
        let errorBody: unknown = {};
        try {
          errorBody = await emailResponse.json();
        } catch {
          throw new RequestError("Permintaan perubahan email tidak valid.", 400);
        }
        const errorDetails = errorBody && typeof errorBody === "object"
          ? errorBody as Record<string, unknown>
          : {};
        throw new RequestError(
          text(errorDetails.msg) || text(errorDetails.message) || "Email pemulihan belum dapat diperbarui.",
          400,
        );
      }
      return jsonResponse({
        status: "success",
        message: "Permintaan perubahan email dikirim. Buka tautan konfirmasi di email tersebut; username tetap sama.",
      }, 200, origin);
    }

    throw new RequestError("Aksi tidak dikenal.", 400);
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status, origin);
    console.error("Admin account request failed:", error);
    return jsonResponse({ error: "Permintaan akun admin gagal diproses." }, 500, origin);
  }
});
