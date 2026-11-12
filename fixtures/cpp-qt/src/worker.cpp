#include "worker.h"
Worker::Worker(QObject *parent) : QObject(parent) {}
void Worker::run() { emit progress(10); emit finished(0); }
void Worker::start() { run(); }
void Controller::onFinished(int code) {}
void Controller::onProgress(int percent) {}
