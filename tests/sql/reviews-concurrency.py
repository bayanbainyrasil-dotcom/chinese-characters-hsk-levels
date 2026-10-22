"""Two real RPC sessions against a disposable local PostgreSQL test database."""
import json
import os
import shutil
import subprocess
import time
import uuid

psql = os.environ.get('PSQL') or shutil.which('psql')
if not psql:
    raise SystemExit('Set PSQL to a PostgreSQL psql executable')
# Intentionally no remote host option: this test creates and removes a synthetic user.
args = [psql, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
        '-p', os.environ.get('PGPORT', '55439'), '-d', 'hsktest']
user = str(uuid.uuid4())

def sql(command):
    return subprocess.check_output(args + ['-c', command], text=True)

def rpc():
    eid = str(uuid.uuid4())
    event = dict(id=eid, attemptId=eid, char='一', kind='answer', mode='review',
                 dueKey='concurrency', grade='good', assisted=False, mistakes=0,
                 at=int(time.time()*1000), day='2026-10-19', device='test', durationMs=1, version=1)
    payload = json.dumps([event], ensure_ascii=False)
    return f"select public.sync_writing_reviews('{payload}'::jsonb);"

prefix = f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{user}',true);"
a = None
try:
    sql(f"insert into auth.users(id,email) values('{user}','concurrency@example.test')")
    command = prefix + f"select pg_advisory_xact_lock(hashtextextended('{user}',0)); select pg_sleep(2);" + rpc() + 'commit;'
    a = subprocess.Popen(args + ['-c', command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic()+5
    while sql("select count(*) from pg_locks l join pg_stat_activity a using(pid) where l.locktype='advisory' and l.granted and a.query like '%concurrency%' ").strip() == '0':
        if time.monotonic()>deadline:
            raise AssertionError('First session never acquired advisory lock')
        time.sleep(.02)
    output = sql(prefix + rpc() + 'commit;')
    _, error = a.communicate(timeout=10)
    assert a.returncode == 0, error
    reply = next(json.loads(line) for line in output.splitlines() if line.startswith('{'))
    assert len(reply['rows']) == 2, 'Second session skipped an uncommitted earlier sequence'
    assert int(sql(f"select count(*) from public.writing_reviews where user_id='{user}'")) == 2
    print('PASS: concurrent RPC inserts serialized; second pull contains both events')
finally:
    if a and a.poll() is None:
        a.terminate()
        a.communicate(timeout=10)
    sql(f"delete from auth.users where id='{user}'")
