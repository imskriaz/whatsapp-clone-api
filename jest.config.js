module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/index.js'
  ],
  verbose: true,
  setupFilesAfterEnv: ['./tests/setup.js']
};