/**
 * What the phone says only once it has been seen to hold on a real cloud
 * workspace. Each switch stays off until a live check shows it; turning one
 * on is a one-line change with the check's evidence in its pull request.
 */

/**
 * The launch form's line under an empty first task, "With no first task, the
 * agent starts and waits for your first message." (25.09). The server stores
 * and delivers a launch with no prompt (`createLaunchIntent`,
 * `claimLaunchIntent`) and the runtime starts the agent's tab and sends a
 * prompt only when there is one (`cloud_agents/launch.rs`): read, not run.
 * Off, the task may still be left empty; nothing says what that does.
 */
export const EMPTY_FIRST_TASK_CHECKED_LIVE = false;
