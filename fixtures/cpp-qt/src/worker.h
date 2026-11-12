#pragma once
#include <QObject>
class Worker : public QObject {
  Q_OBJECT
public:
  explicit Worker(QObject *parent = nullptr);
  void run();
signals:
  void finished(int code);
  void progress(int percent);
public slots:
  void start();
};
class Controller : public QObject {
  Q_OBJECT
public slots:
  void onFinished(int code);
  void onProgress(int percent);
};
