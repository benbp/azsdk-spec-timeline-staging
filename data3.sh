
ORG="https://dev.azure.com/azure-sdk"
PRJ="project=internal"

# Java release build info
az devops invoke --area build --resource builds --organization $ORG --route-parameters $PRJ --query-parameters "buildIds=6087382" --output json | jq -c > java-build-6087382.json

# Java release timeline
az devops invoke --area build --resource timeline --organization $ORG --route-parameters $PRJ buildId=6087382 --output json | jq -c > timeline-6087382.json

# Python release build info
az devops invoke --area build --resource builds --organization $ORG --route-parameters $PRJ --query-parameters "buildIds=6087291" --output json | jq -c > python-build-6087291.json

# Python release timeline
az devops invoke --area build --resource timeline --organization $ORG --route-parameters $PRJ buildId=6087291 --output json | jq -c > timeline-6087291.json

echo "Done!"

