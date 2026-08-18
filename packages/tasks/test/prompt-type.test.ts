import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_TASK_TYPE } from '../src/prompt-type.ts';

test('prompt type: config requires prompt, buildPrompt echoes it', async () => {
  assert.throws(() => PROMPT_TASK_TYPE.configSchema({}));
  const c = PROMPT_TASK_TYPE.configSchema({ prompt: '巡检一下' });
  const p = await PROMPT_TASK_TYPE.buildPrompt({ config: c } as any, {} as any, {} as any);
  assert.equal(p, '巡检一下');
  assert.equal(PROMPT_TASK_TYPE.report, 'optional');
});
