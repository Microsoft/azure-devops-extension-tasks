set INPUT_EXTENSIONID=ext
set INPUT_EXTENSIONVERSION=8.9.10
set INPUT_PUBLISHERID=me
set INPUT_ROOTFOLDER=C:\Users\JesseHouwing\Source\Repos\vsts-ping-task-demo
set INPUT_UPDATETASKSID=true
set INPUT_UPDATETASKSVERSION=true
set INPUT_UPDATETASKSVERSIONTYPE=minor

set AGENT_WORKFOLDER=c:\temp

set NODE_ENV=production
set NO_UPDATE_NOTIFIER=true

cmd /c "npm run build:tasks"

pushd BuildTasks\PackageExtension\PackageExtension
c:\TfsData\jessehouwing\externals.2.111.1\node\bin\node.exe PackageExtension.js
c:\TfsData\jessehouwing\externals.2.136.1\node\bin\node.exe PackageExtension.js
node PackageExtension.js
popd