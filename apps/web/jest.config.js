module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/test/**/*.spec.tsx"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx", esModuleInterop: true } }],
  },
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
};
