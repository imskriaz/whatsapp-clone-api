// public/js/pages/login.js
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('error');
    
    try {
        const result = await auth.login(username, password);
        
        if (result.success) {
            window.location.href = '/dashboard';
        } else {
            errorEl.textContent = result.error;
            errorEl.classList.remove('hidden');
        }
    } catch (error) {
        errorEl.textContent = 'Login failed. Please try again.';
        errorEl.classList.remove('hidden');
    }
});