from celery import shared_task

from celery_app import app


@shared_task
def send_email(address):
    return address


@app.task(name="reports.build", bind=True)
def build_report(self, report_id):
    return report_id
