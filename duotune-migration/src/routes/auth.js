import { Router } from 'express';
import { requireSupabaseUser } from '../middleware/auth.js';
import { supabaseAdmin } from '../supabase.js';

const router = Router();
const ROOM_CODE = process.env.DUOTUNE_ROOM_CODE || 'KIRANUU';
const SHARED_PASSWORD = process.env.DUOTUNE_SHARED_PASSWORD || '';

function constantTimeEqual(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

router.post('/login', requireSupabaseUser, async (req, res) => {
  if (req.body?.action !== 'login') {
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }
  if (!SHARED_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Server configuration missing' });
  }

  const nameInput = String(req.body?.name ?? '').trim().toLowerCase();
  const name = nameInput === 'kiran' ? 'Kiran' : nameInput === 'pooja' ? 'Pooja' : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!name) return res.status(400).json({ success: false, error: 'Choose Kiran or Pooja' });
  if (!constantTimeEqual(password, SHARED_PASSWORD)) {
    return res.status(401).json({ success: false, error: 'Incorrect password' });
  }

  const userId = req.supabaseUser.id;
  try {
    const { data: room, error: roomError } = await supabaseAdmin
      .from('duotune_rooms')
      .select('id, room_code, owner_user_id')
      .eq('room_code', ROOM_CODE)
      .single();

    if (roomError || !room) {
      console.error('[auth] room lookup failed:', roomError);
      return res.status(500).json({ success: false, error: 'DUOTUNE room is not configured' });
    }

    const { data: existingForDevice, error: existingError } = await supabaseAdmin
      .from('duotune_room_members')
      .select('display_name')
      .eq('room_id', room.id)
      .eq('user_id', userId);

    if (existingError) {
      console.error('[auth] identity lookup failed:', existingError);
      return res.status(500).json({ success: false, error: 'Could not verify this device identity' });
    }
    if ((existingForDevice ?? []).some((member) => member.display_name !== name)) {
      return res.status(403).json({
        success: false,
        error: 'This browser is linked to the other DUOTUNE profile. Use a separate browser profile.',
      });
    }

    if (name === 'Kiran') {
      const { error: ownerError } = await supabaseAdmin
        .from('duotune_rooms')
        .update({ owner_user_id: userId })
        .eq('id', room.id);
      if (ownerError) {
        console.error('[auth] owner registration failed:', ownerError);
        return res.status(500).json({ success: false, error: 'Could not register the Kiran profile' });
      }
    } else if (room.owner_user_id === userId) {
      return res.status(403).json({
        success: false,
        error: 'This browser is currently linked to Kiran. Use a separate browser profile for Pooja.',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('duotune_room_members')
      .delete()
      .eq('room_id', room.id)
      .eq('display_name', name)
      .neq('user_id', userId);

    if (deleteError) {
      console.error('[auth] stale membership cleanup failed:', deleteError);
      return res.status(500).json({ success: false, error: 'Could not refresh the room profile' });
    }

    const { error: memberError } = await supabaseAdmin
      .from('duotune_room_members')
      .upsert(
        { room_id: room.id, user_id: userId, display_name: name },
        { onConflict: 'room_id,user_id' },
      );

    if (memberError) {
      console.error('[auth] membership upsert failed:', memberError);
      return res.status(500).json({ success: false, error: 'Could not register this room member' });
    }

    return res.json({
      success: true,
      name,
      userId,
      roomCode: room.room_code,
      roomId: room.id,
      isAdmin: name === 'Kiran',
    });
  } catch (error) {
    console.error('[auth] login request failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to process login request' });
  }
});

export default router;
