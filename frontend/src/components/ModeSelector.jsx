import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { organizationService } from '../services/api';

export default function ModeSelector() {
  const { user, setUser } = useAuth();
  const [selected, setSelected] = useState(user?.mode || 'manual');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Sync mode from backend on mount
  useEffect(() => {
    let isMounted = true;
    const fetchCurrentMode = async () => {
      try {
        const data = await organizationService.getMode();
        if (data && data.success && data.mode) {
          if (isMounted) {
            setSelected(data.mode);
            if (user && user.mode !== data.mode) {
              const updatedUser = { ...user, mode: data.mode };
              setUser(updatedUser);
              localStorage.setItem('user', JSON.stringify(updatedUser));
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch organization mode:', err.message);
      }
    };
    fetchCurrentMode();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleModeChange = async (newMode) => {
    if (newMode === selected || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const data = await organizationService.updateMode(newMode);
      if (data && data.success) {
        setSelected(data.mode);
        const updatedUser = { ...user, mode: data.mode };
        setUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
        setFeedback({ type: 'success', message: `Mode updated to ${data.mode.toUpperCase()}` });
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setFeedback({ type: 'error', message: data?.message || 'Failed to update mode' });
      }
    } catch (err) {
      console.error('Failed to update mode:', err);
      setFeedback({
        type: 'error',
        message: err.response?.data?.message || 'Failed to connect to backend',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mode-selector-wrapper" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
      <span className="mode-label" style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
        Reply Mode:
      </span>
      <div className="mode-toggle-group" style={{ display: 'inline-flex', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)', padding: '3px', border: '1px solid var(--border-color)' }}>
        <button
          type="button"
          className={`btn-mode-toggle ${selected === 'manual' ? 'active-manual' : ''}`}
          onClick={() => handleModeChange('manual')}
          disabled={saving}
          style={{
            padding: '0.35rem 0.75rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s ease',
            backgroundColor: selected === 'manual' ? '#3b82f6' : 'transparent',
            color: selected === 'manual' ? '#ffffff' : 'var(--text-secondary)',
            boxShadow: selected === 'manual' ? '0 1px 3px rgba(59, 130, 246, 0.3)' : 'none',
          }}
        >
          ✍️ Manual
        </button>
        <button
          type="button"
          className={`btn-mode-toggle ${selected === 'auto' ? 'active-auto' : ''}`}
          onClick={() => handleModeChange('auto')}
          disabled={saving}
          style={{
            padding: '0.35rem 0.75rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s ease',
            backgroundColor: selected === 'auto' ? '#10b981' : 'transparent',
            color: selected === 'auto' ? '#ffffff' : 'var(--text-secondary)',
            boxShadow: selected === 'auto' ? '0 1px 3px rgba(16, 185, 129, 0.3)' : 'none',
          }}
        >
          ⚡ Auto
        </button>
      </div>
      {saving && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Saving...</span>}
      {feedback && (
        <span
          style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: feedback.type === 'success' ? '#10b981' : '#ef4444',
            marginLeft: '0.4rem',
          }}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
