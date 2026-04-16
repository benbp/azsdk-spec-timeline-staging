#!/usr/bin/env python3
"""Process raw fetch-timeline.js output into final timeline JSON."""
import json, sys, re
from datetime import datetime

def main():
    if len(sys.argv) < 4:
        print("Usage: process-raw-timeline.py <raw-json> <output-json> <title>", file=sys.stderr)
        sys.exit(1)
    
    raw_file, out_file, title = sys.argv[1], sys.argv[2], sys.argv[3]
    data = json.load(open(raw_file))
    spec = data['specPR']
    sdks = data['sdkPRs']
    owner = spec['author']

    BOT_ACTORS = {'azure-sdk', 'github-actions[bot]', 'azure-pipelines[bot]',
                  'copilot-pull-request-reviewer[bot]', 'Copilot', 'msftbot[bot]'}

    def is_bot(user):
        return user in BOT_ACTORS or (user and user.endswith('[bot]'))

    def actor_role(user):
        if user == owner: return 'author'
        if user in ('Copilot', 'copilot-pull-request-reviewer[bot]'): return 'copilot'
        if is_bot(user): return 'bot'
        return 'reviewer'

    def classify_sentiment(etype):
        if etype in ('pr_merged', 'review_approved'): return 'positive'
        if etype in ('review_changes_requested', 'author_nag'): return 'blocking'
        if etype == 'manual_fix': return 'negative'
        if etype == 'idle_gap': return 'blocking'
        return 'neutral'

    def process_events(pr_data):
        events = []
        raw = pr_data.get('_raw', {})
        
        if pr_data.get('createdAt'):
            events.append({'type': 'pr_created', 'timestamp': pr_data['createdAt'],
                'actor': pr_data['author'], 'actorRole': 'bot' if is_bot(pr_data['author']) else 'author',
                'description': f"PR #{pr_data['number']} opened: {pr_data['title'][:60]}",
                'sentiment': 'neutral', 'details': {'url': pr_data['url']}})
        
        if pr_data.get('mergedAt'):
            events.append({'type': 'pr_merged', 'timestamp': pr_data['mergedAt'],
                'actor': pr_data.get('mergedBy', 'unknown'), 'actorRole': actor_role(pr_data.get('mergedBy', 'unknown')),
                'description': f"PR #{pr_data['number']} merged", 'sentiment': 'positive',
                'details': {'url': pr_data['url']}})
        
        if pr_data.get('state') == 'closed' and not pr_data.get('mergedAt') and pr_data.get('closedAt'):
            events.append({'type': 'pr_closed', 'timestamp': pr_data['closedAt'],
                'actor': 'unknown', 'actorRole': 'reviewer',
                'description': f"PR #{pr_data['number']} closed without merge", 'sentiment': 'neutral',
                'details': {'url': pr_data['url']}})
        
        for c in raw.get('commits', []):
            author = c.get('author', {}).get('login') or c.get('commit', {}).get('author', {}).get('name', 'unknown')
            msg = c.get('commit', {}).get('message', '').split('\n')[0][:60]
            ts = c.get('commit', {}).get('author', {}).get('date') or c.get('commit', {}).get('committer', {}).get('date')
            if ts:
                events.append({'type': 'commit_pushed', 'timestamp': ts, 'actor': author,
                    'actorRole': actor_role(author), 'description': msg, 'sentiment': 'neutral',
                    'details': {'url': c.get('html_url', '')}})
        
        for r in raw.get('reviews', []):
            user = r.get('user', {}).get('login', 'unknown')
            state = r.get('state', '')
            body = r.get('body', '') or ''
            ts = r.get('submitted_at')
            if not ts: continue
            if state == 'APPROVED': etype = 'review_approved'
            elif state == 'CHANGES_REQUESTED': etype = 'review_changes_requested'
            elif state == 'COMMENTED' and body.strip(): etype = 'review_comment'
            else: continue
            events.append({'type': etype, 'timestamp': ts, 'actor': user, 'actorRole': actor_role(user),
                'description': f"{'Approved' if etype == 'review_approved' else 'Changes requested' if etype == 'review_changes_requested' else 'Review comment'} by {user}",
                'sentiment': classify_sentiment(etype),
                'details': {'body': body[:500] if body else None, 'url': r.get('html_url', '')}})
        
        for c in raw.get('comments', []):
            user = c.get('user', {}).get('login', 'unknown')
            body = c.get('body', '') or ''
            ts = c.get('created_at')
            if not ts: continue
            
            if user == owner and any(p in body.lower() for p in ['please review', 'could you check', 'can you merge', 'can you approve', 'please merge', 'can you take a look']):
                mentions = re.findall(r'@(\w+)', body)
                target = [m for m in mentions if m != owner and not is_bot(m)]
                if target:
                    events.append({'type': 'author_nag', 'timestamp': ts, 'actor': user, 'actorRole': 'author',
                        'description': f"Author pinged {', '.join('@'+t for t in target)} for review",
                        'sentiment': 'blocking',
                        'details': {'body': body[:500], 'url': c.get('html_url', ''), 'targetUser': target[0]}})
                    continue
            
            if user == owner and any(p in body.lower() for p in ['manually edited', 'manually ran', 'manual intervention', 'had to manually']):
                events.append({'type': 'manual_fix', 'timestamp': ts, 'actor': user, 'actorRole': 'author',
                    'description': 'Manual fix needed on auto-generated PR', 'sentiment': 'negative',
                    'details': {'body': body[:500], 'url': c.get('html_url', '')}})
                continue
            
            etype = 'bot_comment' if is_bot(user) else 'issue_comment'
            events.append({'type': etype, 'timestamp': ts, 'actor': user, 'actorRole': actor_role(user),
                'description': body[:100].replace('\n', ' ') if body else f"Comment by {user}",
                'sentiment': 'neutral',
                'details': {'body': body[:500] if body else None, 'url': c.get('html_url', '')}})
        
        for c in raw.get('reviewComments', []):
            user = c.get('user', {}).get('login', 'unknown')
            body = c.get('body', '') or ''
            ts = c.get('created_at')
            if not ts: continue
            events.append({'type': 'review_comment', 'timestamp': ts, 'actor': user, 'actorRole': actor_role(user),
                'description': body[:100].replace('\n', ' ') if body else f"Inline review by {user}",
                'sentiment': 'blocking' if user != owner else 'neutral',
                'details': {'body': body[:500] if body else None, 'url': c.get('html_url', '')}})
        
        events.sort(key=lambda e: e['timestamp'])
        
        # Idle gaps
        idle = []
        for i in range(1, len(events)):
            t1 = datetime.fromisoformat(events[i-1]['timestamp'].replace('Z', '+00:00'))
            t2 = datetime.fromisoformat(events[i]['timestamp'].replace('Z', '+00:00'))
            gap_h = (t2 - t1).total_seconds() / 3600
            if gap_h > 24:
                idle.append({'type': 'idle_gap', 'timestamp': events[i-1]['timestamp'],
                    'endTimestamp': events[i]['timestamp'], 'actor': 'system', 'actorRole': 'bot',
                    'description': f"Idle for {gap_h:.0f}h ({gap_h/24:.1f}d)",
                    'sentiment': 'blocking' if gap_h > 72 else 'neutral',
                    'details': {'durationHours': round(gap_h, 1)}})
        events.extend(idle)
        events.sort(key=lambda e: e['timestamp'])
        return events

    def days_between(a, b):
        if not a or not b: return None
        d1 = datetime.fromisoformat(a.replace('Z', '+00:00'))
        d2 = datetime.fromisoformat(b.replace('Z', '+00:00'))
        return round((d2 - d1).total_seconds() / 86400, 2)

    # Process all PRs
    spec_out = {k: v for k, v in spec.items() if k != '_raw'}
    spec_out['events'] = process_events(spec)
    
    sdk_outs = []
    for pr in sdks:
        pr_out = {k: v for k, v in pr.items() if k != '_raw'}
        pr_out['events'] = process_events(pr)
        sdk_outs.append(pr_out)

    # Timestamps
    all_ts = []
    for e in spec_out['events']: 
        all_ts.append(e['timestamp'])
        if e.get('endTimestamp'): all_ts.append(e['endTimestamp'])
    for pr in sdk_outs:
        for e in pr['events']:
            all_ts.append(e['timestamp'])
            if e.get('endTimestamp'): all_ts.append(e['endTimestamp'])
    all_ts.sort()
    start = all_ts[0] if all_ts else spec['createdAt']
    end = all_ts[-1] if all_ts else spec.get('mergedAt', spec['createdAt'])

    # Summary stats
    spec_days = days_between(spec['createdAt'], spec.get('mergedAt'))
    total_days = days_between(start, end)
    first_sdk = min((pr['createdAt'] for pr in sdk_outs if pr.get('createdAt') and pr['state'] != 'missing'), default=None)
    pipe_gap = days_between(spec.get('mergedAt'), first_sdk) if spec.get('mergedAt') and first_sdk else None
    
    durations = [(pr['language'], days_between(pr['createdAt'], pr['mergedAt'])) 
                 for pr in sdk_outs if pr.get('mergedAt') and pr.get('createdAt')]
    durations = [(l, d) for l, d in durations if d is not None]
    fastest = min(durations, key=lambda x: x[1]) if durations else None
    slowest = max(durations, key=lambda x: x[1]) if durations else None
    
    nags = sum(1 for pr in [spec_out]+sdk_outs for e in pr['events'] if e['type'] == 'author_nag')
    manuals = sum(1 for pr in sdk_outs for e in pr['events'] if e['type'] == 'manual_fix')
    reviewers = set(e['actor'] for pr in [spec_out]+sdk_outs for e in pr['events'] if e.get('actorRole') == 'reviewer')

    # Insights
    insights = []
    if pipe_gap is not None and pipe_gap > 0:
        insights.append({'type': 'bottleneck', 'severity': 'info' if pipe_gap < 1 else 'warning',
            'description': f"Pipeline gap: {pipe_gap:.1f}d between spec merge and first SDK PR",
            'durationDays': round(pipe_gap, 1), 'startDate': spec.get('mergedAt'), 'endDate': first_sdk})
    if spec_days and spec_days > 7:
        insights.append({'type': 'bottleneck', 'severity': 'warning',
            'description': f"Spec PR took {spec_days:.0f}d to merge", 'durationDays': round(spec_days),
            'startDate': spec['createdAt'], 'endDate': spec.get('mergedAt'),
            'prRef': f"Azure/azure-rest-api-specs#{spec['number']}"})
    if nags > 0:
        insights.append({'type': 'nag', 'severity': 'warning',
            'description': f"Author sent {nags} review nag(s) across PRs"})
    for pr in sdk_outs:
        if pr['state'] == 'closed' and not pr.get('mergedAt'):
            insights.append({'type': 'summary', 'severity': 'info',
                'description': f"{pr['language']} PR #{pr['number']} closed without merge",
                'prRef': f"{pr['repo']}#{pr['number']}"})
    for pr in sdk_outs:
        if pr['state'] == 'open':
            insights.append({'type': 'bottleneck', 'severity': 'warning',
                'description': f"{pr['language']} PR #{pr['number']} is still open",
                'prRef': f"{pr['repo']}#{pr['number']}"})
    if slowest:
        insights.append({'type': 'summary', 'severity': 'info',
            'description': f"Slowest SDK PR: {slowest[0]} ({slowest[1]:.1f}d)"})
    if fastest:
        insights.append({'type': 'positive', 'severity': 'info',
            'description': f"Fastest SDK PR: {fastest[0]} ({fastest[1]:.1f}d)"})

    output = {
        'title': title, 'owner': owner, 'startDate': start, 'endDate': end,
        'specPR': spec_out, 'sdkPRs': sdk_outs, 'insights': insights,
        'summary': {
            'totalDurationDays': round(total_days, 2) if total_days else None,
            'specPRDays': round(spec_days, 2) if spec_days else None,
            'pipelineGapDays': round(pipe_gap, 2) if pipe_gap else None,
            'sdkPRMaxDays': round(slowest[1], 2) if slowest else None,
            'fastestSDKPR': {'language': fastest[0], 'days': round(fastest[1], 2)} if fastest else None,
            'slowestSDKPR': {'language': slowest[0], 'days': round(slowest[1], 2)} if slowest else None,
            'totalUniqueReviewers': len(reviewers), 'totalNags': nags,
            'totalManualFixes': manuals, 'totalPREdits': 0
        }
    }

    with open(out_file, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"✅ {out_file} — spec={len(spec_out['events'])} events, {len(sdk_outs)} SDK PRs, {len(insights)} insights")
    for pr in sdk_outs:
        print(f"   {pr['language']:6s} #{pr['number']} {pr['state']:8s} {len(pr['events'])} events")

if __name__ == '__main__':
    main()
