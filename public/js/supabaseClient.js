// supabaseClient.js
// Crea el cliente de Supabase una sola vez, usando las credenciales de config.js
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
