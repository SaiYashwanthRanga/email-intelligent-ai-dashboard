import React from 'react';
import { AlertTriangle, Clock, BellRing, CheckCircle2, Info } from 'lucide-react';

// Gradient highlight card at the bottom of the side panel.
export default function FollowUpSummary({ stats, config }) {
  const items = [
    { icon: AlertTriangle, value: stats.overdue, label: 'Overdue' },
    { icon: Clock, value: stats.remindersReady, label: 'Reminders ready' },
    { icon: BellRing, value: stats.remindersSent, label: 'Reminders sent' },
    { icon: CheckCircle2, value: `${stats.replyRate}%`, label: 'Reply rate' },
  ];
  const days = config.reminder_days.join(', ');
  return (
    <section className="trk-followup">
      <h3 className="trk-followup__title">Follow-up queue</h3>
      <div className="trk-followup__grid">
        {items.map(({ icon: Icon, value, label }) => (
          <div key={label} className="trk-followup__item">
            <span className="trk-followup__icon"><Icon size={15} /></span>
            <div>
              <div className="trk-followup__value">{value}</div>
              <div className="trk-followup__label">{label}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="trk-followup__note">
        <Info size={14} />
        On days {days} the AI checks whether a reply is still needed and the Day-{config.reminder_days[0]} / Day-{config.reminder_days[config.reminder_days.length - 1]} template reminder is prepared.
        No reply by day {config.overdue_after_days} → overdue, for manual follow-up.{' '}
        {config.reminder_mode === 'manual'
          ? 'Manual mode: reminders go out only when you send them.'
          : 'Automatic mode: reminders are sent for you.'}
      </p>
    </section>
  );
}
