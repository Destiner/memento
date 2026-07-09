// Stop-hook capture gate (§3.2 "hard gate" variant): before the session ends,
// make the agent decide once whether a durable insight emerged. Claude Code sets
// stop_hook_active when a stop was already blocked by a hook — allowing that
// pass through is what makes the gate fire exactly once instead of looping.
const input = JSON.parse(await Bun.stdin.text()) as { stop_hook_active?: boolean };

if (!input.stop_hook_active) {
  console.log(
    JSON.stringify({
      decision: 'block',
      reason:
        'Before finishing: did this task surface a durable, cross-project insight ' +
        '(a vendor quirk, a rate limit discovered the hard way, an incident lesson, ' +
        'a decision that will repeat)? If yes, save it with the memento create_memory ' +
        'tool. If not, finish now — do not record routine task status.',
    }),
  );
}
