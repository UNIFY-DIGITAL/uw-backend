"""Mail plumbing smoke test against the local stack (no apps involved).

alice -> bob (internal), alice -> outside (relayed to MailHog), a forged From
(must be refused), and an outside server delivering to bob over SMTP.
Then lists both mailboxes through Puter's file API.
"""
import json, os, re, smtplib, sys, time, urllib.request, uuid

def _env():
    # .env: the suite's domain and mail domain (scripts/lib/suite.sh derives the rest the same way).
    out = {}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    for line in open(path):
        m = re.match(r"\s*([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m:
            v = re.sub(r"\s+#.*$", "", m.group(2)).strip()
            out[m.group(1)] = v[1:-1] if len(v) > 1 and v[0] == v[-1] and v[0] in "'\"" else v
    return {**out, **os.environ}
ENV = _env()
PROTO, DOMAIN, MAIL = ENV.get("PUTER_PROTOCOL", "http"), ENV["PUTER_DOMAIN"], ENV["MAIL_DOMAIN"]
ORIGIN, API = f"{PROTO}://{DOMAIN}", f"{PROTO}://api.{DOMAIN}"
PASS = "Unify-test-123"

def call(url, body=None, token=None, ctype="application/json", origin=False):
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    if data is not None: req.add_header("Content-Type", ctype)
    if token: req.add_header("Authorization", f"Bearer {token}")
    if origin: req.add_header("Origin", ORIGIN)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")

def login(user):
    status, body = call(f"{ORIGIN}/login", {"username": user, "password": PASS}, origin=True)
    assert status == 200 and body.get("token"), (user, status, body)
    return body["token"]

def message(frm, to, subject, body="Hello from the smoke test."):
    return (f"From: {frm}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime())}\r\n"
            f"Message-ID: <{uuid.uuid4()}@{MAIL}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n").encode()

alice, bob = login("alice"), login("bob")
ok = True

def inbox_count(user, token):
    s, days = call(f"{API}/readdir", {"path": f"/{user}/.mail/objects"}, token)
    total = 0
    for d in (days or []) if s == 200 else []:
        s2, items = call(f"{API}/readdir", {"path": d["path"]}, token)
        total += len(items or [])
    return total

bob_before = inbox_count("bob", bob)
def check(label, cond, detail):
    global ok; ok &= bool(cond); print(f"  {'PASS' if cond else 'FAIL'}  {label}: {detail}")

print("== /email/send")
s, b = call(f"{API}/email/send", message(f"alice@{MAIL}", f"bob@{MAIL}", "Lunch tomorrow?"), alice, "message/rfc822")
check("alice -> bob (internal)", s == 200 and f"bob@{MAIL}" in b.get("delivered", []), (s, b))
s, b = call(f"{API}/email/send", message(f"alice@{MAIL}", "partner@gmail.example", "External hello"), alice, "message/rfc822")
check("alice -> outside (relay)", s == 200 and "partner@gmail.example" in b.get("delivered", []), (s, b))
s, b = call(f"{API}/email/send", message(f"bob@{MAIL}", f"alice@{MAIL}", "Forged"), alice, "message/rfc822")
check("forged From refused", s == 403 and b.get("code") == "from_mismatch", (s, b))
s, b = call(f"{API}/email/send", message(f"alice@{MAIL}", f"nobody@{MAIL}", "No such user"), alice, "message/rfc822")
check("unknown local user reported", s == 502 and b["failed"][0]["error"] == "no_such_user", (s, b.get("failed")))

print("== inbound SMTP (an outside server delivering to bob)")
with smtplib.SMTP("localhost", 2525, timeout=30) as smtp:
    smtp.sendmail("carol@partner.example", [f"bob@{MAIL}"], message("carol@partner.example", f"bob@{MAIL}", "Hi Bob, from outside"))
check("SMTP accepted", True, f"carol@partner.example -> bob@{MAIL}")
time.sleep(1.5)

print("== mailboxes (Puter file API)")
print(f"  alice: {inbox_count('alice', alice)} message(s) in Inbox")
bob_after = inbox_count("bob", bob)
check("bob received 2 new messages (alice + carol)", bob_after - bob_before == 2, f"{bob_before} -> {bob_after}")

print("== MailHog (outside world)")
with urllib.request.urlopen("http://localhost:8025/api/v2/messages") as r:
    hog = json.load(r)
check("relayed mail reached MailHog", any("partner@gmail.example" in str(m["Raw"]["To"]) for m in hog["items"]), f"{hog['total']} message(s)")
print("\nALL PASSED" if ok else "\nSOME CHECKS FAILED"); sys.exit(0 if ok else 1)
