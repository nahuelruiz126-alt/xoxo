// auth.js
// Controla el login con Supabase Auth y qué pantalla se muestra (login o app).

const pantallaLogin = document.getElementById("pantalla-login");
const appContenido = document.getElementById("app-contenido");

async function verificarSesion() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  mostrarSegunSesion(session);
}

function mostrarSegunSesion(session) {
  if (session) {
    pantallaLogin.hidden = true;
    appContenido.hidden = false;
    // Recarga los datos de la app apenas hay sesión activa
    if (typeof cargarPedidos === "function") cargarPedidos();
    if (typeof cargarCadetes === "function") cargarCadetes();
    if (typeof cargarProductos === "function") cargarProductos();
    if (typeof iniciarCierres === "function") iniciarCierres();
  } else {
    pantallaLogin.hidden = false;
    appContenido.hidden = true;
  }
}

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.hidden = true;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = "Email o contraseña incorrectos.";
    errorEl.hidden = false;
    return;
  }
  mostrarSegunSesion(data.session);
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  mostrarSegunSesion(null);
});

supabaseClient.auth.onAuthStateChange((_evento, session) => mostrarSegunSesion(session));

verificarSesion();
