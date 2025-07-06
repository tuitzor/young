document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const adminNameEl = document.getElementById('admin-name');
  const logoutBtn = document.getElementById('logout-btn');
  const onlineAdminsEl = document.getElementById('online-admins');
  const totalAdminsEl = document.getElementById('total-admins');
  const activeConnectionsEl = document.getElementById('active-connections');
  const totalScreenshotsEl = document.getElementById('total-screenshots');
  const screenshotsContainer = document.getElementById('screenshots-container');
  const adminManagement = document.getElementById('admin-management');
  const adminList = document.getElementById('admin-list');
  const newAdminLogin = document.getElementById('new-admin-login');
  const newAdminPassword = document.getElementById('new-admin-password');
  const addAdminBtn = document.getElementById('add-admin-btn');

  // Current admin data
  let currentAdmin = null;
  let isSuperAdmin = false;

  // Check auth and load data
  async function init() {
    try {
      const response = await fetch('/api/admin/stats');
      if (!response.ok) throw new Error('Auth required');
      
      const data = await response.json();
      updateStats(data);
      
      // Load admin info
      const adminResponse = await fetch('/api/admin/list');
      if (adminResponse.ok) {
        const admins = await adminResponse.json();
        currentAdmin = admins.find(a => a.login === document.cookie.match(/admin=([^;]+)/)?.[1]);
        isSuperAdmin = currentAdmin?.isSuperAdmin;
        
        adminNameEl.textContent = currentAdmin?.login || 'Админ';
        if (isSuperAdmin) {
          adminNameEl.classList.add('super-admin');
          renderAdminList(admins);
        } else {
          adminManagement.style.display = 'none';
        }
      }
      
      loadScreenshots();
      startStatsUpdater();
    } catch (error) {
      console.error('Ошибка инициализации:', error);
      window.location.href = '/admin/login';
    }
  }

  // Update stats
  function updateStats(data) {
    onlineAdminsEl.textContent = data.onlineAdmins;
    totalAdminsEl.textContent = data.totalAdmins;
    activeConnectionsEl.textContent = data.activeConnections;
    totalScreenshotsEl.textContent = data.totalScreenshots;
  }

  // Load screenshots
  async function loadScreenshots() {
    try {
      const response = await fetch('/api/screenshots');
      if (!response.ok) throw new Error('Ошибка загрузки');
      
      const screenshots = await response.json();
      renderScreenshots(screenshots);
    } catch (error) {
      console.error('Ошибка загрузки скриншотов:', error);
    }
  }

  // Render screenshots
  function renderScreenshots(screenshots) {
    screenshotsContainer.innerHTML = '';
    
    if (screenshots.length === 0) {
      screenshotsContainer.innerHTML = '<p>Нет скриншотов для отображения</p>';
      return;
    }
    
    screenshots.forEach(screenshot => {
      const card = document.createElement('div');
      card.className = 'screenshot-card';
      card.innerHTML = `
        <div class="screenshot-img-container">
          <img src="${screenshot.url}" alt="Скриншот ${screenshot.id}" loading="lazy">
        </div>
        <div class="screenshot-info">
          <p>ID: ${screenshot.id}</p>
          <p>Дата: ${new Date(screenshot.timestamp).toLocaleString()}</p>
        </div>
        <div class="answer-section">
          <textarea data-id="${screenshot.id}" placeholder="Введите ответ...">${screenshot.answer || ''}</textarea>
          <button class="send-answer-btn" data-id="${screenshot.id}">Отправить</button>
        </div>
      `;
      screenshotsContainer.appendChild(card);
    });
    
    // Add event listeners
    document.querySelectorAll('.send-answer-btn').forEach(btn => {
      btn.addEventListener('click', sendAnswer);
    });
  }

  // Send answer
  async function sendAnswer(e) {
    const btn = e.target;
    const questionId = btn.getAttribute('data-id');
    const answer = document.querySelector(`textarea[data-id="${questionId}"]`).value;
    
    btn.disabled = true;
    btn.textContent = 'Отправка...';
    
    try {
      const response = await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, answer })
      });
      
      if (!response.ok) throw new Error('Ошибка отправки');
      btn.textContent = 'Отправлено!';
      setTimeout(() => { btn.textContent = 'Отправить'; btn.disabled = false; }, 2000);
    } catch (error) {
      console.error('Ошибка:', error);
      btn.textContent = 'Ошибка';
      setTimeout(() => { btn.textContent = 'Отправить'; btn.disabled = false; }, 2000);
    }
  }

  // Render admin list
  function renderAdminList(admins) {
    adminList.innerHTML = '';
    admins.forEach(admin => {
      const adminEl = document.createElement('div');
      adminEl.className = 'admin-item';
      adminEl.innerHTML = `
        <span class="${admin.isSuperAdmin ? 'super-admin' : ''}">
          ${admin.login} 
          <span class="${admin.online ? 'online' : 'offline'}">(${admin.online ? 'онлайн' : 'офлайн'})</span>
        </span>
        ${!admin.isSuperAdmin ? `<span class="remove-admin" data-login="${admin.login}">×</span>` : ''}
      `;
      adminList.appendChild(adminEl);
    });
    
    // Add event listeners
    document.querySelectorAll('.remove-admin').forEach(btn => {
      btn.addEventListener('click', removeAdmin);
    });
  }

  // Remove admin
  async function removeAdmin(e) {
    const login = e.target.getAttribute('data-login');
    if (!confirm(`Удалить администратора ${login}?`)) return;
    
    try {
      const response = await fetch('/api/admin/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login })
      });
      
      if (!response.ok) throw new Error('Ошибка удаления');
      
      // Reload admin list
      const adminResponse = await fetch('/api/admin/list');
      if (adminResponse.ok) {
        const admins = await adminResponse.json();
        renderAdminList(admins);
        
        // Update stats
        const statsResponse = await fetch('/api/admin/stats');
        if (statsResponse.ok) {
          updateStats(await statsResponse.json());
        }
      }
    } catch (error) {
      console.error('Ошибка:', error);
      alert('Не удалось удалить администратора');
    }
  }

  // Add new admin
  async function addAdmin() {
    const login = newAdminLogin.value.trim();
    const password = newAdminPassword.value.trim();
    
    if (!login || !password) {
      alert('Заполните все поля');
      return;
    }
    
    addAdminBtn.disabled = true;
    addAdminBtn.textContent = 'Добавление...';
    
    try {
      const response = await fetch('/api/admin/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Ошибка добавления');
      }
      
      // Clear form
      newAdminLogin.value = '';
      newAdminPassword.value = '';
      
      // Reload admin list
      const adminResponse = await fetch('/api/admin/list');
      if (adminResponse.ok) {
        const admins = await adminResponse.json();
        renderAdminList(admins);
        
        // Update stats
        const statsResponse = await fetch('/api/admin/stats');
        if (statsResponse.ok) {
          updateStats(await statsResponse.json());
        }
      }
    } catch (error) {
      console.error('Ошибка:', error);
      alert(error.message);
    } finally {
      addAdminBtn.disabled = false;
      addAdminBtn.textContent = 'Добавить';
    }
  }

  // Logout
  async function logout() {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    } catch (error) {
      console.error('Ошибка выхода:', error);
    }
  }

  // Stats updater
  function startStatsUpdater() {
    setInterval(async () => {
      try {
        const response = await fetch('/api/admin/stats');
        if (response.ok) {
          updateStats(await response.json());
        }
      } catch (error) {
        console.error('Ошибка обновления статистики:', error);
      }
    }, 10000);
  }

  // Event listeners
  logoutBtn.addEventListener('click', logout);
  addAdminBtn.addEventListener('click', addAdmin);

  // Initialize
  init();
});