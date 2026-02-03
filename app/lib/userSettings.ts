import { createBrowserSupabaseClient } from "./supabase";

export async function fetchUserSetting<T>(userId: string, settingKey: string): Promise<T | null> {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_settings")
    .select("value")
    .eq("user_id", userId)
    .eq("setting_key", settingKey)
    .maybeSingle();
  if (error || !data) return null;
  return data.value as T;
}

export async function saveUserSetting<T>(
  userId: string,
  settingKey: string,
  value: T
): Promise<boolean> {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        setting_key: settingKey,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,setting_key" }
    );
  return !error;
}
