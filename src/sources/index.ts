import type { Ats } from '../domain/types.ts';
import { ashby } from './ashby/index.ts';
import type { BoardSource } from './types.ts';

/** Typed as a full Record so adding an ATS to ATS_VALUES fails to compile until it has an adapter. */
export const SOURCES: Record<Ats, BoardSource> = {
  ashby,
};
