import { describe, expect, test } from 'bun:test';
import { inferProjectBootstrapIntent } from '../src/projects/bootstrap-intent.js';

describe('project bootstrap intent', () => {
  test('detects natural-language project bootstrap with repo url', () => {
    const intent = inferProjectBootstrapIntent('open a new channel and project space for https://github.com/Korde-AI/OttoOS where we will collaborate with other human and agents to finish it');
    expect(intent.shouldHandle).toBe(true);
    expect(intent.displayName).toBe('OttoOS');
    expect(intent.slug).toBe('ottoos');
    expect(intent.destination).toBe('channel');
    expect(intent.projectType).toBe('programming');
  });

  test('detects bind-here language', () => {
    const intent = inferProjectBootstrapIntent('create a project for release planning and use this channel for the collaboration room');
    expect(intent.shouldHandle).toBe(true);
    expect(intent.destination).toBe('here');
    expect(intent.projectType).toBe('general');
  });

  test('defaults generic project space requests to the current room', () => {
    const intent = inferProjectBootstrapIntent('create a local space for the SkillTree project and sync the basic statement');
    expect(intent.shouldHandle).toBe(true);
    expect(intent.destination).toBe('here');
    expect(intent.slug).toBe('the-skilltree-project');
  });

  test('ignores normal chat', () => {
    const intent = inferProjectBootstrapIntent('hey can you summarize the last patch?');
    expect(intent.shouldHandle).toBe(false);
  });

  test('does not retrigger on follow-up question about prior bootstrap action', () => {
    const intent = inferProjectBootstrapIntent('why you open a thread rather than a channel ?');
    expect(intent.shouldHandle).toBe(false);
  });

  test('infers design and research project types', () => {
    expect(inferProjectBootstrapIntent('create a new project for the product design mockups').projectType).toBe('design');
    expect(inferProjectBootstrapIntent('start a research project for paper analysis').projectType).toBe('research');
  });
});
