import { fileURLToPath } from 'node:url';
import next from 'next';

try {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

  const { createApp } = await import('../backend/dist/app.js');
  const nextApp = next({ dev: false, dir: fileURLToPath(new URL('.', import.meta.url)) });
  await nextApp.prepare();

  // Nest 綁定唯一的 HTTP 入口，完成 Host 檢查後才交由 Next 處理頁面。
  const app = await createApp({ frontend: nextApp.getRequestHandler() });
  await app.listen(port, '0.0.0.0');
} catch {
  console.error('會員平台啟動失敗。請檢查容器設定及初始化狀態。');
  process.exit(1);
}
