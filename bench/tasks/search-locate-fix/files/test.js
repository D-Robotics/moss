import assert from 'node:assert/strict';

const cases = [
  { file: 'm01.js', input: 3, expected: 107 },
  { file: 'm02.js', input: 4, expected: 114 },
  { file: 'm03.js', input: 5, expected: 123 },
  { file: 'm04.js', input: 6, expected: 134 },
  { file: 'm05.js', input: 7, expected: 147 },
  { file: 'm06.js', input: 8, expected: 162 },
  { file: 'm07.js', input: 9, expected: 179 },
  { file: 'm08.js', input: 10, expected: 198 },
  { file: 'm09.js', input: 11, expected: 219 },
  { file: 'm10.js', input: 12, expected: 242 },
  { file: 'm11.js', input: 13, expected: 267 },
  { file: 'm12.js', input: 14, expected: 294 },
  { file: 'm13.js', input: 15, expected: 323 },
  { file: 'm14.js', input: 16, expected: 354 },
  { file: 'm15.js', input: 17, expected: 387 },
  { file: 'm16.js', input: 18, expected: 422 },
  { file: 'm17.js', input: 19, expected: 459 },
  { file: 'm18.js', input: 20, expected: 498 },
  { file: 'm19.js', input: 21, expected: 539 },
  { file: 'm20.js', input: 22, expected: 582 },
];

for (const c of cases) {
  const mod = await import(`./src/modules/${c.file}`);
  const actual = mod.f(c.input);
  assert.equal(
    actual,
    c.expected,
    `${c.file}: f(${c.input}) should be ${c.expected} but was ${actual}`
  );
}
console.log('all tests passed');
