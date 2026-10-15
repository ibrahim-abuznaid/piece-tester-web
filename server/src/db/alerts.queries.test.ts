import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getSettings, updateSettings, createAlert, getOpenAlert, updateAlert, acknowledgeAlert, recoverAlert, listOpenAlerts } from './queries.js';

describe('notify settings', () => {
  beforeEach(() => {
    getDb().run(`UPDATE settings SET notify_webhook_url='', notify_enabled=0, notify_storm_threshold=8, notify_retest_count=2, notify_reauth_digest_time='09:00' WHERE id=1`);
  });

  it('round-trips the discord webhook + toggles', () => {
    updateSettings({ notify_webhook_url: 'https://discord.com/api/webhooks/1/abc', notify_enabled: 1, notify_storm_threshold: 5, notify_retest_count: 3, notify_reauth_digest_time: '13:30' });
    const s = getSettings();
    expect(s.notify_webhook_url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(s.notify_enabled).toBe(1);
    expect(s.notify_storm_threshold).toBe(5);
    expect(s.notify_retest_count).toBe(3);
    expect(s.notify_reauth_digest_time).toBe('13:30');
  });
});

describe('alert CRUD', () => {
  beforeEach(() => getDb().exec('DELETE FROM alerts;'));

  it('creates then finds the open alert for a target', () => {
    const a = createAlert({ piece_name: '@ap/stripe', target_action: 'create_customer', error_signature: 'piece_error:x', error_category: 'piece_error', error_message: 'boom', last_run_id: 1, last_wave_id: 'w1', schedule_id: 2 });
    expect(a.status).toBe('verifying');
    const open = getOpenAlert('@ap/stripe', 'create_customer');
    expect(open?.id).toBe(a.id);
  });

  it('recovered alerts are no longer "open"', () => {
    const a = createAlert({ piece_name: '@ap/x', target_action: 'a', error_signature: 's', error_category: 'piece_error', error_message: 'e' });
    recoverAlert(a.id);
    expect(getOpenAlert('@ap/x', 'a')).toBeUndefined();
    expect(listOpenAlerts()).toHaveLength(0);
  });

  it('acknowledge records who + when and keeps it open', () => {
    const a = createAlert({ piece_name: '@ap/y', target_action: 'b', error_signature: 's', error_category: 'piece_error', error_message: 'e' });
    updateAlert(a.id, { status: 'confirmed' });
    const ack = acknowledgeAlert(a.id, 'web session');
    expect(ack?.status).toBe('acknowledged');
    expect(ack?.acknowledged_by).toBe('web session');
    expect(getOpenAlert('@ap/y', 'b')?.status).toBe('acknowledged');
  });

  it('does not return an account credits notice as a target alert', () => {
    createAlert({ piece_name: '@ap/hf', target_action: 'inference', target_type: 'account', error_signature: 'quota', error_category: 'quota', error_message: 'no credits' });
    expect(getOpenAlert('@ap/hf', 'inference')).toBeUndefined();
    expect(listOpenAlerts().some(x => x.piece_name === '@ap/hf' && x.target_type === 'account')).toBe(true);
  });
});
