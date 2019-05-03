/**
 * Run unit tests
 */

import { cli } from "./cli";

const main = async () => {
  return cli();
};

if (require.main === module) {
  main().catch(e => {
    throw e;
  });
}
