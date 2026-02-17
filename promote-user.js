// promote-user.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

async function promoteUser() {
    const db = await open({
        filename: path.join(__dirname, 'data', 'db.db'),
        driver: sqlite3.Database
    });

    const username = 'testuser_4_1771329474298';
    
    // Promote to superadmin
    await db.run(
        'UPDATE users SET role = ? WHERE username = ?',
        ['superadmin', username]
    );
    
    console.log(`✅ User ${username} promoted to superadmin`);
    
    // Verify
    const user = await db.get('SELECT username, role, api_key FROM users WHERE username = ?', [username]);
    console.log('📝 User details:', user);
    
    await db.close();
}

promoteUser();