import {
  formatActivityDate,
  formatActivityTime,
  type ActivityHistory,
} from "@/lib/activity";

type ActivityTimelineSectionProps = {
  activities: ActivityHistory[];
};

export function ActivityTimelineSection({
  activities,
}: ActivityTimelineSectionProps) {
  return (
    <section className="mt-10 space-y-6 border-t border-gray-800 pt-8">
      <div>
        <h2 className="text-xl font-semibold text-white">Activity Timeline</h2>
        <p className="mt-1 text-sm text-gray-400">
          Recent activity for this lead, newest first.
        </p>
      </div>

      {activities.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-8 text-center text-sm text-gray-500">
          No activity yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {activities.map((activity) => (
            <li
              key={activity.id}
              className="rounded-xl border border-gray-800 bg-black/40 p-4"
            >
              <p className="text-sm text-gray-200">{activity.summary}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>{formatActivityDate(activity.created_at)}</span>
                <span>{formatActivityTime(activity.created_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
