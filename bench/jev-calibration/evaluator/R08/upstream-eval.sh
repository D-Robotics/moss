#!/bin/bash
set -uxo pipefail
cd /testbed
git config --global --add safe.directory /testbed
git status
git show
git -c core.fileMode=false diff 77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6
git checkout 77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6 __tests__/OrderedMap.ts __tests__/OrderedSet.ts
git apply -v - <<'EOF_114329324912'
diff --git a/__tests__/OrderedMap.ts b/__tests__/OrderedMap.ts
index 8ed3f8d06..0472f8b8a 100644
--- a/__tests__/OrderedMap.ts
+++ b/__tests__/OrderedMap.ts
@@ -129,4 +129,13 @@ describe('OrderedMap', () => {
 
     expect(map.size).toBe(SIZE / 2 - 1);
   });
+
+  it('hashCode should return the same value if the values are the same', () => {
+    const m1 = OrderedMap({ b: 'b' });
+    const m2 = OrderedMap({ a: 'a', b: 'b' }).remove('a');
+    const m3 = OrderedMap({ b: 'b' }).remove('b').set('b', 'b');
+
+    expect(m1.hashCode()).toEqual(m2.hashCode());
+    expect(m1.hashCode()).toEqual(m3.hashCode());
+  });
 });
diff --git a/__tests__/OrderedSet.ts b/__tests__/OrderedSet.ts
index 6dbf7f4d1..54045232f 100644
--- a/__tests__/OrderedSet.ts
+++ b/__tests__/OrderedSet.ts
@@ -142,4 +142,11 @@ describe('OrderedSet', () => {
     expect(out.has(second)).toBe(false);
     expect(out.has(third)).toBe(true);
   });
+
+  it('hashCode should return the same value if the values are the same', () => {
+    const set1 = OrderedSet(['hello']);
+    const set2 = OrderedSet(['goodbye', 'hello']).remove('goodbye');
+
+    expect(set1.hashCode()).toBe(set2.hashCode());
+  });
 });

EOF_114329324912
npm run build
: '>>>>> Start Test Output'
(npx jest __tests__/OrderedMap.ts __tests__/OrderedSet.ts --silent --json | jq -r '.testResults[].assertionResults[] | "[" + (.status | ascii_upcase) + "] " + ((.ancestorTitles | join(" > ")) + (if .ancestorTitles | length > 0 then " > " else "" end) + .title)') | cat
: '>>>>> End Test Output'
git checkout 77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6 __tests__/OrderedMap.ts __tests__/OrderedSet.ts
