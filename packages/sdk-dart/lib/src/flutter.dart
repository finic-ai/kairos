import 'dart:async';

import 'package:flutter/widgets.dart';

import 'kairos.dart';

/// Sends the screen events of the client settings as routes are pushed. The name of a screen
/// is the name of its route: `RouteSettings.name`, or the `name` of a GoRoute.
class KairosNavigatorObserver extends NavigatorObserver {
  KairosNavigatorObserver(this.kairos);

  final Kairos kairos;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _show(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _show(newRoute);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _show(previousRoute);

  void _show(Route<dynamic>? route) {
    final name = route?.settings.name;
    if (route is PageRoute && name != null) kairos.screen(name);
  }
}

/// Sends what is queued when the app goes to the background, and starts a new visit when it
/// comes back after 30 minutes.
class KairosLifecycle with WidgetsBindingObserver {
  KairosLifecycle._(this.kairos);

  final Kairos kairos;

  static KairosLifecycle attach(Kairos kairos) {
    final lifecycle = KairosLifecycle._(kairos);
    WidgetsBinding.instance.addObserver(lifecycle);
    return lifecycle;
  }

  void detach() => WidgetsBinding.instance.removeObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.detached) {
      unawaited(kairos.paused());
    } else if (state == AppLifecycleState.resumed) {
      kairos.resumed();
    }
  }
}
