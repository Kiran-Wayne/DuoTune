import { createUserClient } from '../supabase.js';

export async function requireSupabaseUser(req, res, next) {
  const authorization = req.get('authorization') || '';

  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Sign in to DUOTUNE before using this service.',
    });
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return res.status(401).json({ error: 'Sign-in required.' });
  }

  try {
    const client = createUserClient(token);
    const { data, error } = await client.auth.getUser(token);

    if (error || !data?.user) {
      console.error('[auth] Supabase getUser rejected token:', {
        message: error?.message,
        status: error?.status,
        code: error?.code,
      });

      return res.status(401).json({
        error: 'Your DUOTUNE session is invalid. Rejoin the room and try again.',
      });
    }

    req.supabaseUser = data.user;
    req.supabaseUserClient = client;

    next();
  } catch (error) {
    console.error('[auth] session verification failed:', error);

    return res.status(401).json({
      error: 'Your DUOTUNE session is invalid. Rejoin the room and try again.',
    });
  }
}
