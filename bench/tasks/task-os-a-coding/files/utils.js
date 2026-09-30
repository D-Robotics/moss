/**
 * Shared string helpers for the demo workspace.
 */

/**
 * SPEC — slugify(text):
 *   Lowercase the input, replace every run of non-alphanumeric characters
 *   with a single hyphen, trim leading/trailing hyphens, collapse repeats.
 *   Examples (normative):
 *     slugify('Hello, Task OS!')  === 'hello-task-os'
 *     slugify('  --Multilingual--résumé? ') === 'multilingual-r-sum'
 *     slugify('')                 === ''
 *   ('é' is non-alphanumeric in ASCII terms → dropped; edge runs trimmed.)
 */
