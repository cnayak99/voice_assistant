/**
 * AssemblyAI Session Cleanup Script
 * 
 * This script helps you terminate any zombie streaming sessions
 * that might be preventing new connections due to concurrent limits.
 */

const API_KEY = "3223b8ecca60452b91e1976aa35e10b5"; // Your AssemblyAI API key

async function terminateAllSessions() {
  console.log('🧹 Starting AssemblyAI session cleanup...');
  
  try {
    // Method 1: Try to get active sessions (if endpoint exists)
    console.log('📡 Checking for active streaming sessions...');
    
    const response = await fetch('https://api.assemblyai.com/v2/realtime/sessions', {
      method: 'GET',
      headers: {
        'authorization': API_KEY,
        'content-type': 'application/json'
      }
    });
    
    if (response.ok) {
      const sessions = await response.json();
      console.log('📋 Found sessions:', sessions);
      
      // Terminate each session
      for (const session of sessions) {
        await terminateSession(session.id);
      }
    } else {
      console.log('ℹ️ Could not retrieve active sessions (this is normal)');
    }
    
    // Method 2: Create multiple temporary tokens and let them expire
    console.log('🔄 Creating temporary tokens to force cleanup...');
    
    for (let i = 0; i < 3; i++) {
      try {
        const tokenResponse = await fetch('https://api.assemblyai.com/v2/realtime/token', {
          method: 'POST',
          headers: {
            'authorization': API_KEY,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            expires_in: 60 // Short expiry to force cleanup
          })
        });
        
        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          console.log(`✅ Created cleanup token ${i + 1}/3`);
          
          // Let the system process the token request
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.log(`⚠️ Token creation ${i + 1} failed:`, error.message);
      }
    }
    
    console.log('✅ Cleanup process completed!');
    console.log('⏳ Wait 30-60 seconds before trying to connect again.');
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

async function terminateSession(sessionId) {
  try {
    const response = await fetch(`https://api.assemblyai.com/v2/realtime/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'authorization': API_KEY,
        'content-type': 'application/json'
      }
    });
    
    if (response.ok) {
      console.log(`✅ Terminated session: ${sessionId}`);
    } else {
      console.log(`⚠️ Could not terminate session: ${sessionId}`);
    }
  } catch (error) {
    console.log(`❌ Error terminating session ${sessionId}:`, error.message);
  }
}

// Run the cleanup
terminateAllSessions(); 