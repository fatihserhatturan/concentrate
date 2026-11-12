#include <QCoreApplication>
#include "worker.h"
class Window : public QObject {
  Q_OBJECT
public:
  Window();
public slots:
  void quit();
};
Window::Window() {
  auto *worker = new Worker(this);
  connect(worker, SIGNAL(finished(int)), this, SLOT(quit()));
  QObject::connect(worker, &Worker::progress, this, [](int p) {});
}
void Window::quit() {}
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  Worker worker;
  Controller controller;
  QObject::connect(&worker, &Worker::finished, &controller, &Controller::onFinished);
  QObject::connect(&worker, &Worker::progress, &controller, &Controller::onProgress);
  return app.exec();
}
