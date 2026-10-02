/* Elze Contract AI — ribbon commands for the Word add-in.
 * Only taskpane actions are wired for now; kept minimal to satisfy the
 * manifest FunctionFile reference.
 */
/* global Office */

Office.initialize = function () {};

function openTaskpane(event) {
  // Reserved for a future ExecuteFunction action if we add ribbon-run analysis.
  event.completed();
}
