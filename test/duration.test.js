import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimePlan, formatMinutes, MAX_MINUTES } from '../lib/duration.js';

const minutes = (text) => parseTimePlan(text).minutes;
const every = (text) => parseTimePlan(text).everyMinutes;

test('reads time budgets written in plain words', () => {
  assert.equal(minutes('watch the page for 20 minutes'), 20);
  assert.equal(minutes('do this for 2 hours'), 120);
  assert.equal(minutes('keep going for an hour'), 60);
  assert.equal(minutes('for half an hour please'), 30);
  assert.equal(minutes('within 15 mins'), 15);
  assert.equal(minutes('over the next 3 hours'), 180);
  assert.equal(minutes('for the next ten minutes'), 10);
  assert.equal(minutes('for about five minutes'), 5);
  assert.equal(minutes('up to 90 seconds'), 1.5);
  assert.equal(minutes('for 1.5 hours'), 90);
});

test('reads compact and compound forms', () => {
  assert.equal(minutes('for 1h 30m'), 90);
  assert.equal(minutes('for 2 hours and 15 minutes'), 135);
  assert.equal(minutes('run for 10m'), 10);
  assert.equal(minutes('run for 2h'), 120);
});

test('reads how often to check', () => {
  const plan = parseTimePlan('check the price every 5 minutes for an hour');
  assert.deepEqual(plan, { minutes: 60, everyMinutes: 5 });
  assert.equal(every('check every hour'), 60);
  assert.equal(every('poll every minute'), 1);
  assert.equal(every('ping every 30 seconds'), 0.5);
  assert.equal(every('every 10m'), 10);
});

test('an "every" interval is not mistaken for the time budget', () => {
  assert.equal(minutes('check every 5 minutes'), null);
});

test('returns nothing when no time is mentioned', () => {
  assert.deepEqual(parseTimePlan('Go to example.com and read the title'), { minutes: null, everyMinutes: null });
  assert.deepEqual(parseTimePlan(''), { minutes: null, everyMinutes: null });
  assert.deepEqual(parseTimePlan(undefined), { minutes: null, everyMinutes: null });
  assert.equal(minutes('I have a 5 minute walk'), null);
});

test('clamps to sensible limits', () => {
  assert.equal(minutes('for 100 hours'), MAX_MINUTES);
  assert.equal(minutes('for 5 seconds'), 0.5);
});

test('formats durations for display', () => {
  assert.equal(formatMinutes(20), '20 min');
  assert.equal(formatMinutes(60), '1 h');
  assert.equal(formatMinutes(90), '1 h 30 min');
  assert.equal(formatMinutes(0.5), '30 sec');
  assert.equal(formatMinutes(null), '');
});
