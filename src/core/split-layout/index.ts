/**
 * Split git layout (Wave B PR 5, spec §9 option B): the format core. A page whose canonical file would exceed
 * `sync.max_file_bytes` is stored as a head file at its path plus hidden part files beside it. This module plans,
 * renders, parses, verifies and reassembles that layout; publication and sync wire it in.
 */
export * from './limits.ts';
export * from './types.ts';
export * from './paths.ts';
export * from './head.ts';
export * from './plan.ts';
export * from './verify.ts';
export * from './page-file.ts';
