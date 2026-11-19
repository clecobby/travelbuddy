// Run the API on your machine against the dev AWS resources (see backend/.env.example).
import { app } from './server.ts';

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
  console.warn('⚠ ANTHROPIC_API_KEY is not set (backend/.env), so /api/chat will fail.');

const port = Number(process.env.PORT) || 4100;
app.listen(port, () => console.log(`Travel Buddy API on http://localhost:${port} (table ${process.env.TABLE}, bucket ${process.env.MEDIA_BUCKET})`));
