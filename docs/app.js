const steps = [
  { title: 'Share the contract. Claim the work.', detail: 'Claude writes the API contract, claims the task, and reserves src/health.ts.', actor: 'claude', states: ['Working', 'Ready', 'Ready'], tasks: ['Owns src/health.ts', 'Can read shared API contract', 'Can read shared API contract'], icon: '01' },
  { title: 'Catch the overlap before editing.', detail: 'DeepSeek requests the same file. Relay returns FILE_CONFLICT.', actor: 'deepseek', states: ['Working', 'Conflict', 'Ready'], tasks: ['Still owns src/health.ts', 'Overlapping claim rejected', 'Can work on another task'], icon: '↔' },
  { title: 'Pass the task with its context.', detail: 'Claude releases the file and hands off. DeepSeek receives a durable inbox message.', actor: 'deepseek', states: ['Handed off', 'Assigned', 'Ready'], tasks: ['File claim released', 'Handoff waiting in inbox', 'Shared decisions available'], icon: '→' },
  { title: 'Pick up exactly where it left off.', detail: 'DeepSeek claims the task, acknowledges the message, and records the demo result.', actor: 'deepseek', states: ['Ready', 'Completed', 'Ready'], tasks: ['Can read the shared result', 'Task complete with context', 'Waiting for result broadcast'], icon: '✓' },
  { title: 'The whole project stays in the loop.', detail: 'Gemini receives and acknowledges the result broadcast. Context stays in the project.', actor: 'gemini', states: ['In sync', 'In sync', 'In sync'], tasks: ['Result remains in shared state', 'Result broadcast delivered', 'Result received and acknowledged'], icon: '✓' },
];
const ids = ['claude', 'deepseek', 'gemini'];
const play = document.querySelector('#play-demo');
const next = document.querySelector('#step-demo');
let current = -1;
let timer;
function pause() { clearInterval(timer); timer = undefined; play.textContent = current === 4 ? '↻ Replay the handoff' : '▶ Play the handoff'; }
function render(index) {
  const step = steps[index];
  document.querySelector('#event-counter').textContent = `0${index + 1} / 05`;
  document.querySelector('#event-title').textContent = step.title;
  document.querySelector('#event-detail').textContent = step.detail;
  document.querySelector('#event-check').textContent = step.icon;
  ids.forEach((id, i) => {
    const peer = document.querySelector(`#peer-${id}`);
    peer.classList.toggle('active', id === step.actor);
    peer.querySelector('.peer-state').textContent = step.states[i];
    peer.querySelector('.peer-task').textContent = step.tasks[i];
  });
  document.querySelectorAll('.steps span').forEach((dot, i) => dot.classList.toggle('done', i <= index));
  document.querySelector('#demo-announcement').textContent = `Step ${index + 1} of 5. ${step.title} ${step.detail}`;
  next.textContent = index === 4 ? 'Restart' : 'Next step';
}
function advance() { current = (current + 1) % steps.length; render(current); if (current === 4) pause(); }
play.addEventListener('click', () => {
  if (timer) { pause(); return; }
  if (current === 4) current = -1;
  advance();
  if (current !== 4) { play.textContent = 'Ⅱ Pause replay'; timer = setInterval(advance, 3500); }
});
next.addEventListener('click', () => { pause(); advance(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const command = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = 'Copied';
      document.querySelector('#copy-status').textContent = 'Command copied to clipboard.';
      setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    } catch {
      document.querySelector('#copy-status').textContent = 'Clipboard unavailable. Select and copy the command below.';
      button.textContent = 'Select text';
    }
  });
}
