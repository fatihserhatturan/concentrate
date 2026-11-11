import tasks
from celery_app import app
from tasks import build_report, send_email


def notify(address):
    send_email.delay(address)
    build_report.apply_async(args=[1])
    tasks.send_email.s("x")
    app.send_task("reports.build", args=[2])
