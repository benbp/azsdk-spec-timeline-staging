
ORG="https://dev.azure.com/azure-sdk"
PRJ="project=internal"

# .NET build timeline
az devops invoke --area build --resource timeline --organization $ORG --route-parameters $PRJ buildId=6071262 --output json | jq -c > timeline-6071262.json

# JS build timeline
az devops invoke --area build --resource timeline --organization $ORG --route-parameters $PRJ buildId=6107778 --output json | jq -c > timeline-6107778.json

# Search for Java pipeline with different name patterns
az devops invoke --area build --resource definitions --organization $ORG --route-parameters $PRJ --query-parameters "name=java - resourcemanager-search" --output json | jq -c > java-def-2.json

# Search for Python pipeline with different name pattern
az devops invoke --area build --resource definitions --organization $ORG --route-parameters $PRJ --query-parameters "name=python - azure-mgmt-search" --output json | jq -c > python-def.json

echo "Done! Files: timeline-6071262.json timeline-6107778.json java-def-2.json python-def.json"

