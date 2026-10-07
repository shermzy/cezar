import { hc, type InferResponseType } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { SdlcAudit, SdlcBaselineApply, SdlcBaselinePlan } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const sdlc = client.api.v1.workspace.sdlc;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// The contract must describe EXACTLY what each route sends — no wider, no narrower.
type Audit = Assert<Exact<SdlcAudit, InferResponseType<typeof sdlc.audit.$get, 200>>>;
type Plan = Assert<Exact<SdlcBaselinePlan, InferResponseType<(typeof sdlc.baseline.plan)['$post'], 200>>>;
type Apply = Assert<Exact<SdlcBaselineApply, InferResponseType<(typeof sdlc.baseline.apply)['$post'], 201>>>;

// Never invoked: compile-time proof that the body validators reached AppType.
function typedBodies() {
  sdlc.baseline.plan.$post({ json: { projectIds: ['a'] } });
  // @ts-expect-error the body is required middleware input
  sdlc.baseline.plan.$post({ json: {} });
  // @ts-expect-error ids are strings
  sdlc.baseline.apply.$post({ json: { projectIds: [1] } });
}
void typedBodies;

describe('sdlc contract parity', () => {
  it('is checked at compile time', () => {
    const proof: [Audit, Plan, Apply] = [true, true, true];
    expect(proof).toEqual([true, true, true]);
  });
});
