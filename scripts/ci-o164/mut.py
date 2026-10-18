import sys
def edit(p, old, new):
    s=open(p).read(); assert old in s, (p, old[:60]); open(p,'w').write(s.replace(old,new,1))
m=sys.argv[1]
if m=='item1':
    s=open('src/utils/dotenv-denied-env.ts').read()
    for k in ["  'SYSTEMROOT',\n","  'WINDIR',\n","  'SYSTEMDRIVE',\n","  'PROGRAMFILES(X86)',\n","  'PSMODULEPATH',\n","  'NODEFAULTCURRENTDIRECTORYINEXEPATH',\n"]:
        s=s.replace(k,'')
    open('src/utils/dotenv-denied-env.ts','w').write(s)
    edit('src/utils/system-root.ts',"  env: Record<string, string | undefined> = envForSystemPaths()","  env: Record<string, string | undefined> = process.env")
    edit('src/utils/system-root.ts',"    if (value && /^[A-Za-z]:[\\\\/]/.test(value)) return value;","    if (value) return value;\n    void envForSystemPaths;")
elif m=='item2':
    edit('src/utils/resolve-executable.ts',"const cleaned = kept.length > 0 ? kept.join(sep) : noTrustedPath(platform);","const cleaned = kept.join(sep);")
elif m=='f2a':
    edit('src/utils/host-shell.ts',"  return knownPwshLocations(envForSystemPaths());","  return knownPwshLocations(process.env);\n  void envForSystemPaths;")
elif m=='f2b':
    edit('src/utils/resolve-executable.ts',"(win && (isUncPath(file) || !/^[A-Za-z]:[\\\\/]/.test(file)))","false")
    edit('src/utils/resolve-executable.ts',"    if (win && isUncPath(realDir)) continue;\n","")
    edit('src/utils/host-shell.ts',"    if (dir && /^[A-Za-z]:[\\\\/]/.test(dir))","    if (dir)")
    edit('src/utils/host-shell.ts',"  if (local && /^[A-Za-z]:[\\\\/]/.test(local)) {","  if (local) {")
    s=open('src/utils/resolve-executable.ts').read()
    s=s.replace("export function resolveExecutable(","void isUncPath;\nexport function resolveExecutable(",1)
    open('src/utils/resolve-executable.ts','w').write(s)
