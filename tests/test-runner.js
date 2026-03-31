
import { tests, TEST_TIMEOUT } from "./test-helpers.js";


export async function runTests(/** @type {unknown} */ _onTestComplete) {
  const startTime = Date.now();
  const testPromises = [];

  for (const test of tests) {
    for (const itBlock of test.itBlocks) {
      /** @type {Promise<{ testDesc: string; itDesc: string; passed: boolean; error?: any }> } */
      const promise = new Promise(async (resolve, _reject) => {
        let timer;
        try {
          await Promise.race([
            itBlock.fn(),
            new Promise((_, reject) =>
              timer = setTimeout(() => reject("Timeout"), TEST_TIMEOUT)
            ),
          ]);
          resolve({ testDesc: test.desc, itDesc: itBlock.desc, passed: true });
        } catch (error) {
          resolve({
            testDesc: test.desc,
            itDesc: itBlock.desc,
            passed: false,
            error,
          });
        } finally {
          clearTimeout(timer);
        }
      })
      .then((result) => {
        if (result.passed) {
          console.log(`✔ ${result.testDesc}: ${result.itDesc}`);
          document.body.innerHTML += `<div class="test-passed" style="color: green">✔ ${result.testDesc}: ${result.itDesc}</div>`;
        } else {
          console.error(`✘ ${result.testDesc}: ${result.itDesc} - ${result.error}:\n ${result.error.stack}`);
          document.body.innerHTML += `<div class="test-failed" style="color: red">✘ ${result.testDesc}: ${result.itDesc} - ${result.error}:\n <pre>${result.error.stack} </pre></div>`;
        }
        return result;
      });
      testPromises.push(promise);
    }
  }

  const testResults = await Promise.all(testPromises);

  const endTime = Date.now();
  const duration = endTime - startTime;
  const failedCount = testResults.filter(r => !r.passed).length;

  console.log(`Finished running ${testResults.length} tests in ${duration}ms`);
  console.log(`DONE:${failedCount}`);
  document.body.innerHTML += `<div class="test-summary">Finished running ${testResults.length} tests in ${duration}ms</div>`;
}
