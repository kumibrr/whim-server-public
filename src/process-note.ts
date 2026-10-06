import type { Secrets, ConfigChange } from './types.ts';
import type { Store } from './store.ts';
import { transcribe, decide, validatePlan, ApiFailure } from './openai.ts';
import { buildWebhookRequest, sendWebhook, DeliveryFailure } from './pipes.ts';
import { voiceSettings } from './config.ts';
export async function processNext(store: Store, secrets: Secrets, now: number, signal?: AbortSignal, clock: () => number = Date.now): Promise<boolean> {
  const job = store.claim(now);
  if (!job) return false;
  let stage: 'transcription' | 'decision' | null = null;
  let activeAction: number | null = null;
  try {
    const settings = store.revision(job.revisionId!).settings;
    const api = {baseUrl: secrets.openaiBaseUrl, signal};
    if (job.transcript === null) {
      stage = 'transcription';
      if (job.transcriptionAttempts >= 3) throw new ApiFailure('Transcription retries exhausted');
      store.recordAttempt(job.noteId, stage);
      job.transcript = await transcribe(job.audio!, settings, secrets.openaiKey ?? '', api);
      store.saveTranscript(job.noteId, job.transcript);
    }
    if (job.plan === null) {
      stage = 'decision';
      if (job.decisionAttempts >= 3) throw new ApiFailure('Decision retries exhausted');
      store.recordAttempt(job.noteId, stage);
      job.plan = await decide(job.transcript, settings, secrets.openaiKey ?? '', api);
      store.savePlan(job.noteId, job.plan);
    }
    stage = null;
    validatePlan({routing: 'matched', actions: job.plan.actions}, settings);
    const outcomes = store.actionOutcomes(job.noteId);
    // Build every outstanding request before the first effect, including mappings and credentials.
    const requests = job.plan.actions.map((action, index) => action.pipeId === 'configure' || outcomes[index].status === 'succeeded'
      ? null : buildWebhookRequest(action, job, settings, secrets));
    let configuration = settings, expectedRevisionId = job.revisionId!;
    for (let index = 0; index < job.plan.actions.length; index++) {
      const action = job.plan.actions[index], outcome = outcomes[index];
      if (action.pipeId === 'configure') {
        configuration = voiceSettings(configuration, action.args.changes as unknown as ConfigChange[]);
        if (outcome.status === 'succeeded') { expectedRevisionId = outcome.revisionId!; continue; }
        expectedRevisionId = store.configureAction(job.noteId, index, configuration, expectedRevisionId).id;
      } else {
        if (outcome.status === 'succeeded') continue;
        activeAction = index; store.beginAction(job.noteId, index);
        await sendWebhook(requests[index]!, 30_000, signal);
        store.finishAction(job.noteId, index, 'succeeded'); activeAction = null;
      }
    }
    store.succeed(job.noteId);
  } catch (e) {
    if (stage && e instanceof ApiFailure) {
      const current = store.getNote(job.noteId);
      const count = stage === 'transcription' ? current.transcriptionAttempts : current.decisionAttempts;
      if (e.retryable && count < 3) store.hold(job.noteId, 'retrying', e.message, Math.max(clock() + (count === 1 ? 30_000 : 120_000), e.retryAfter ?? 0));
      else store.hold(job.noteId, 'failed', e.message);
    } else if (activeAction !== null) {
      const uncertain = !(e instanceof DeliveryFailure) || e.uncertain;
      const error = e instanceof DeliveryFailure ? e.message : 'Interrupted webhook checkpoint';
      store.finishAction(job.noteId, activeAction, uncertain ? 'uncertain' : 'failed', error);
      store.hold(job.noteId, uncertain ? 'uncertain' : 'failed', error);
    } else store.hold(job.noteId, 'failed', 'Processing validation or stale configuration failure');
  }
  return true;
}
