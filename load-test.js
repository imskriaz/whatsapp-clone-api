// test-session-creation.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const API_KEY = '2dbfc9e729e3894784e43eb6799ff0ce45284600fc9d9b9358eafbbb06dc7437';
const BASE_URL = 'http://localhost:3000/api';

async function testSessionCreation() {
    console.log('='.repeat(60));
    console.log('🔧 Testing Session Creation');
    console.log('='.repeat(60));
    
    try {
        // First, check if we can access the API
        console.log('\n1. Testing API connection...');
        const health = await axios.get(`${BASE_URL}/health`);
        console.log('✅ Server is healthy');

        // Check user info
        console.log('\n2. Checking user info...');
        const userInfo = await axios.get(`${BASE_URL}/user`, {
            headers: { 'x-api-key': API_KEY }
        });
        console.log('✅ User authenticated:', userInfo.data.username, `(${userInfo.data.role})`);

        // Try to create a session
        console.log('\n3. Attempting to create session...');
        
        const sessionData = {
            platform: 'web',
            device: `test-device-${Date.now()}`
        };
        
        console.log('   Sending:', sessionData);

        const response = await axios.post(`${BASE_URL}/sessions`, 
            sessionData,
            { 
                headers: { 
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        console.log('✅ Session created successfully!');
        console.log('   Response:', JSON.stringify(response.data, null, 2));
        
        const sessionId = response.data.sid;
        
        // Check session state
        console.log('\n4. Checking session state...');
        const stateResponse = await axios.get(`${BASE_URL}/sessions/${sessionId}/state`, {
            headers: { 'x-api-key': API_KEY }
        });
        console.log('   State:', stateResponse.data);
        
        // Get QR code
        console.log('\n5. Getting QR code...');
        const qrResponse = await axios.get(`${BASE_URL}/sessions/${sessionId}/qr`, {
            headers: { 'x-api-key': API_KEY }
        });
        
        if (qrResponse.data.qr) {
            console.log('✅ QR code received!');
            console.log('   QR Code (first 50 chars):', qrResponse.data.qr.substring(0, 50) + '...');
            console.log('\n📱 Scan this QR code with WhatsApp to connect');
        } else {
            console.log('⏳ QR code not ready yet. Session state:', qrResponse.data);
        }
        
        // List all sessions
        console.log('\n6. Listing all sessions...');
        const sessions = await axios.get(`${BASE_URL}/sessions`, {
            headers: { 'x-api-key': API_KEY }
        });
        
        console.log(`   Found ${sessions.data.length} session(s):`);
        sessions.data.forEach((s, i) => {
            console.log(`   ${i+1}. ${s.sid} - ${s.state} - Connected: ${s.connected}`);
        });
        
    } catch (error) {
        if (error.response) {
            console.error('❌ Error:', error.response.status, error.response.data);
            
            // If it's a 403, let's check permissions
            if (error.response.status === 403) {
                console.log('\n🔐 Permission issue detected. Checking user role...');
                try {
                    const userInfo = await axios.get(`${BASE_URL}/user`, {
                        headers: { 'x-api-key': API_KEY }
                    });
                    console.log('   User role:', userInfo.data.role);
                    console.log('   Note: Only superadmin and admin can create sessions by default');
                } catch (e) {
                    console.log('   Could not fetch user info');
                }
            }
        } else {
            console.error('❌ Error:', error.message);
        }
    }
}

testSessionCreation();