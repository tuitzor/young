document.addEventListener('DOMContentLoaded', () = {
  const loginBtn = document.getElementById('login-btn');
  const loginInput = document.getElementById('login');
  const passwordInput = document.getElementById('password');
  const errorEl = document.getElementById('login-error');

  async function login() {
    const login = loginInput.value.trim();
    const password = passwordInput.value.trim();
    
    if (!login  !password) {
      errorEl.textContent = 'Заполните все поля';
      return;
    }
    
    loginBtn.disabled = true;
    errorEl.textContent = '';
    
    try {
      const response = await fetch('apiadminlogin', {
        method 'POST',
        headers { 'Content-Type' 'applicationjson' },
        body JSON.stringify({ login, password })
      });
      
      if (response.ok) {
        window.location.href = 'admin';
      } else {
        const error = await response.json();
        throw new Error(error.error  'Ошибка входа');
      }
    } catch (error) {
      console.error('Ошибка', error);
      errorEl.textContent = error.message;
    } finally {
      loginBtn.disabled = false;
    }
  }

  loginBtn.addEventListener('click', login);
  
   Allow login on Enter key
  passwordInput.addEventListener('keyup', (e) = {
    if (e.key === 'Enter') login();
  });
});