/**
 * Symphony orchestrator tool — skill-provided tool for starting/stopping Symphony.
 *
 * This tool is loaded by the skill system from skills/symphony/tools/.
 * It delegates to the same core orchestrator used by the CLI.
 */

export { symphonyTools as tools } from '../../../src/tools/symphony.js';
