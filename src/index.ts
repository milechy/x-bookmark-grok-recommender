import { startLocalServer } from './app.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  try {
    console.log('🚀 Starting X Bookmark Grok Recommender Slack Bot...');
    console.log('📋 コマンド:');
    console.log('   /bookmark <要件> - Grokがブックマークからおすすめを推薦');
    console.log('   /bookmark-sync   - ブックマークを強制同期');
    
    await startLocalServer();
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

main();
