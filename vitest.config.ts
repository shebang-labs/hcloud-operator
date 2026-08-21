import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                // The process entrypoint only wires modules together and calls
                // process.exit; it is covered by running the operator, not by
                // unit tests.
                'src/main.ts',
                // Pure TLS wiring: read two files, listen, close. Everything it
                // does with a request lives in admission/handler.ts, which is
                // tested over plain http and is at 100%. Testing this file would
                // mean shipping a private key as a fixture to prove that
                // node:https listens.
                'src/admission/server.ts',
            ],
            reporter: ['text', 'html', 'lcov'],
            // Measured, not aspirational: set just under where the suite is so a
            // change that quietly drops coverage fails CI. Raise them when the
            // number goes up; never lower them to make a build pass.
            thresholds: {
                lines: 93,
                statements: 93,
                functions: 94,
                branches: 83,
            },
        },
    },
});
