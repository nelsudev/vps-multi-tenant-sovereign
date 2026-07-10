/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'refactor', 'chore', 'ci', 'test']],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-case': [2, 'always', ['lower-case']],
    'header-max-length': [2, 'always', 72],
  },
};
