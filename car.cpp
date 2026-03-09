#include <vector>
#include <algorithm>
// -- SECTION: CAR_COMMAND ------------------------------------------------------
// car.cpp — #included by reactor.cpp after sendToBot(), memoryGet(), memorySet()

void handleCar(const std::string& username, const std::string& args, const std::string& channel) {
    auto memGet = [&](const std::string& k) -> std::string { return memoryGet(k); };
    auto memSet = [&](const std::string& k, const std::string& v) { memorySet(k, v); };

    auto sendToChat = [&](const std::string& msg) {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2,2), &wsa);
        SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a;
        a.sin_family = AF_INET;
        a.sin_port = htons(9001);
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        connect(s, (sockaddr*)&a, sizeof(a));
        send(s, msg.c_str(), msg.size(), 0);
        closesocket(s);
        WSACleanup();
        Sleep(300); // small delay between messages so they arrive in order
    };

    // ---- CAR LIST (edit here to add/change cars later) ----
    // Format: { name, price, tier (1=slowest, 10=fastest) }
    struct CarDef { std::string name; long long price; int tier; };
    std::vector<CarDef> carList = {
        { "Civic",      500,    1 },
        { "Mustang",    2000,   2 },
        { "Charger",    4500,   3 },
        { "BMW M3",     8000,   4 },
        { "Porsche",    14000,  5 },
        { "Lamborghini",28000,  6 },
        { "Ferrari",    45000,  7 },
        { "Bugatti",    90000,  8 },
        { "Pagani",     150000, 9 },
        { "Koenigsegg", 250000, 10 },
    };

    const int CARS_PER_PAGE = 5; // change this to adjust page size
    const int PRICE_PAGES   = 1; // pages that show prices (first N pages)

    // ---- PARSE ARGS ----
    std::string sub  = "";
    std::string arg1 = "";
    std::string arg2 = "";
    std::istringstream argStream(args);
    argStream >> sub >> arg1 >> arg2;
    if (!arg1.empty() && arg1[0] == '@') arg1 = arg1.substr(1);

    // helper: find car index by name or number (1-based), returns -1 if not found
    auto findCar = [&](const std::string& query) -> int {
        // try number first
        bool isNum = !query.empty();
        for (char c : query) if (!isdigit(c)) { isNum = false; break; }
        if (isNum) {
            int idx = std::stoi(query) - 1;
            if (idx >= 0 && idx < (int)carList.size()) return idx;
            return -1;
        }
        // try name (case-insensitive partial match)
        std::string ql = query;
        std::transform(ql.begin(), ql.end(), ql.begin(), ::tolower);
        for (int i = 0; i < (int)carList.size(); i++) {
            std::string nl = carList[i].name;
            std::transform(nl.begin(), nl.end(), nl.begin(), ::tolower);
            if (nl.find(ql) != std::string::npos) return i;
        }
        return -1;
    };

    // helper: get user's garage as vector of car names
    auto getGarage = [&](const std::string& user) -> std::vector<std::string> {
        std::string raw = memGet("garage_" + user);
        std::vector<std::string> cars;
        if (raw.empty()) return cars;
        std::istringstream ss(raw);
        std::string token;
        while (std::getline(ss, token, ',')) {
            if (!token.empty()) cars.push_back(token);
        }
        return cars;
    };

    // helper: save garage vector back to memory
    auto saveGarage = [&](const std::string& user, const std::vector<std::string>& garage) {
        std::string val = "";
        for (int i = 0; i < (int)garage.size(); i++) {
            if (i > 0) val += ",";
            val += garage[i];
        }
        memSet("garage_" + user, val);
    };

    // helper: get car tier for racing (highest tier car in garage wins more)
    auto getBestTier = [&](const std::string& user) -> int {
        std::vector<std::string> garage = getGarage(user);
        int best = 0;
        for (auto& carName : garage) {
            for (auto& cd : carList) {
                if (cd.name == carName && cd.tier > best) best = cd.tier;
            }
        }
        return best;
    };

    // helper: cash helpers
    auto getCash = [&](const std::string& user) -> long long {
        std::string val = memGet("cash_" + user);
        if (val.empty()) { memSet("cash_" + user, "25"); return 25; }
        return std::stoll(val);
    };
    auto setCash = [&](const std::string& user, long long amount) {
        memSet("cash_" + user, std::to_string(amount));
    };

    // ---- DEALERSHIP ----
    if (sub == "dealership" || sub == "shop" || sub == "list") {
        int page = 1;
        if (!arg1.empty()) {
            bool isNum = true;
            for (char c : arg1) if (!isdigit(c)) { isNum = false; break; }
            if (isNum) page = std::stoi(arg1);
        }

        int totalCars = (int)carList.size();
        int totalPages = (totalCars + CARS_PER_PAGE - 1) / CARS_PER_PAGE;
        if (page < 1) page = 1;
        if (page > totalPages) page = totalPages;

        int start = (page - 1) * CARS_PER_PAGE;
        int end   = std::min(start + CARS_PER_PAGE, totalCars);
        bool showPrices = (page <= PRICE_PAGES);

        std::string out = "\xF0\x9F\x9A\x97 Dealership p" + std::to_string(page) + "/" + std::to_string(totalPages) + ": ";
        for (int i = start; i < end; i++) {
            if (i > start) out += " | ";
            out += std::to_string(i + 1) + ". " + carList[i].name;
            if (showPrices) out += " $" + std::to_string(carList[i].price);
        }
        if (page < totalPages) out += "  (!car dealership " + std::to_string(page + 1) + " for more)";
        if (!showPrices) out += "  (!car price <name> for details)";

        sendToChat(out);
        return;
    }

    // ---- PRICE ----
    if (sub == "price") {
        if (arg1.empty()) {
            sendToChat("@" + username + " usage: !car price <name or number>");
            return;
        }
        int idx = findCar(arg1);
        if (idx < 0) {
            sendToChat("@" + username + " car not found. Use !car dealership to browse.");
            return;
        }
        sendToChat("@" + username + " \xF0\x9F\x9A\x97 " + carList[idx].name + " costs $" + std::to_string(carList[idx].price) + " — type !car buy " + carList[idx].name + " to purchase.");
        return;
    }

    // ---- BUY ----
    if (sub == "buy") {
        if (arg1.empty()) {
            sendToChat("@" + username + " usage: !car buy <name or number>");
            return;
        }
        int idx = findCar(arg1);
        if (idx < 0) {
            sendToChat("@" + username + " car not found. Use !car dealership to browse.");
            return;
        }
        long long price = carList[idx].price;
        long long cash  = getCash(username);
        if (cash < price) {
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash. Need $" + std::to_string(price) + ", you have $" + std::to_string(cash) + ".");
            return;
        }
        // check if already owned
        std::vector<std::string> garage = getGarage(username);
        for (auto& c : garage) {
            if (c == carList[idx].name) {
                sendToChat("@" + username + " you already own a " + carList[idx].name + "! Check !car garage.");
                return;
            }
        }
        // purchase
        setCash(username, cash - price);
        garage.push_back(carList[idx].name);
        saveGarage(username, garage);
        sendToChat("@" + username + " \xF0\x9F\x9A\x97 bought a " + carList[idx].name + " for $" + std::to_string(price) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash - price) + " remaining.");
        return;
    }

    // ---- GARAGE ----
    if (sub == "garage" || sub == "cars") {
        std::string target = arg1.empty() ? username : arg1;
        std::vector<std::string> garage = getGarage(target);
        if (garage.empty()) {
            sendToChat("@" + target + " has no cars. Use !car dealership to browse!");
            return;
        }
        std::string out = "\xF0\x9F\x9A\x97 @" + target + "'s garage: ";
        for (int i = 0; i < (int)garage.size(); i++) {
            if (i > 0) out += " | ";
            out += garage[i];
        }
        sendToChat(out);
        return;
    }

    // ---- SELL ----
    if (sub == "sell") {
        if (arg1.empty()) {
            sendToChat("@" + username + " usage: !car sell <name or number>");
            return;
        }
        std::vector<std::string> garage = getGarage(username);
        if (garage.empty()) {
            sendToChat("@" + username + " you don't own any cars.");
            return;
        }
        // find car in garage by name
        std::string sellName = "";
        long long sellPrice = 0;
        std::string ql = arg1;
        std::transform(ql.begin(), ql.end(), ql.begin(), ::tolower);
        for (auto& cd : carList) {
            std::string nl = cd.name;
            std::transform(nl.begin(), nl.end(), nl.begin(), ::tolower);
            if (nl.find(ql) != std::string::npos) {
                // check if in garage
                for (auto& g : garage) {
                    if (g == cd.name) { sellName = cd.name; sellPrice = cd.price; break; }
                }
            }
            if (!sellName.empty()) break;
        }
        if (sellName.empty()) {
            sendToChat("@" + username + " you don't own that car. Check !car garage.");
            return;
        }
        long long payout = (sellPrice * 70) / 100;
        garage.erase(std::remove(garage.begin(), garage.end(), sellName), garage.end());
        saveGarage(username, garage);
        long long cash = getCash(username);
        setCash(username, cash + payout);
        sendToChat("@" + username + " sold " + sellName + " for $" + std::to_string(payout) + " (70%). \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
        return;
    }

    // ---- RACE ----
    if (sub == "race") {
        if (arg1.empty()) {
            sendToChat("@" + username + " usage: !car race @user <bet>");
            return;
        }
        if (arg2.empty()) {
            sendToChat("@" + username + " usage: !car race @user <bet>");
            return;
        }
        std::string target = arg1;
        long long bet = 0;
        bool isNum = !arg2.empty();
        for (char c : arg2) if (!isdigit(c)) { isNum = false; break; }
        if (!isNum) { sendToChat("@" + username + " bet must be a number."); return; }
        bet = std::stoll(arg2);
        if (bet <= 0) { sendToChat("@" + username + " bet must be greater than $0."); return; }
        if (target == username) { sendToChat("@" + username + " you can't race yourself!"); return; }

        long long myCash = getCash(username);
        if (myCash < bet) {
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash. You have $" + std::to_string(myCash) + ".");
            return;
        }

        // check challenger has a car
        std::vector<std::string> myGarage = getGarage(username);
        if (myGarage.empty()) {
            sendToChat("@" + username + " you need a car to race! Use !car buy.");
            return;
        }

        // store pending race challenge
        long long now = (long long)time(nullptr);
        memSet("racepending_" + target, username + ":" + std::to_string(bet) + ":" + std::to_string(now));

        sendToChat("/me @" + target + " — @" + username + " challenges you to a race for $" + std::to_string(bet) + "! Type !car accept or !car decline (60s to respond)");
        return;
    }

    // ---- ACCEPT ----
    if (sub == "accept") {
        std::string pending = memGet("racepending_" + username);
        if (pending.empty()) {
            sendToChat("@" + username + " no pending race challenge.");
            return;
        }
        // parse pending: challenger:bet:timestamp
        std::istringstream ps(pending);
        std::string challenger, betStr, tsStr;
        std::getline(ps, challenger, ':');
        std::getline(ps, betStr, ':');
        std::getline(ps, tsStr, ':');

        long long now = (long long)time(nullptr);
        long long ts  = tsStr.empty() ? 0 : std::stoll(tsStr);
        if (now - ts > 60) {
            memSet("racepending_" + username, "");
            sendToChat("@" + username + " that race challenge expired.");
            return;
        }

        long long bet         = std::stoll(betStr);
        long long myCash      = getCash(username);
        long long theirCash   = getCash(challenger);

        if (myCash < bet) {
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash to cover the $" + std::to_string(bet) + " bet.");
            return;
        }
        if (theirCash < bet) {
            memSet("racepending_" + username, "");
            sendToChat("@" + challenger + " no longer has enough cash for the race.");
            return;
        }

        // check both have cars
        std::vector<std::string> myGarage     = getGarage(username);
        std::vector<std::string> theirGarage  = getGarage(challenger);
        if (myGarage.empty()) {
            sendToChat("@" + username + " you need a car to race! Use !car buy.");
            return;
        }
        if (theirGarage.empty()) {
            memSet("racepending_" + username, "");
            sendToChat("@" + challenger + " doesn't have a car anymore!");
            return;
        }

        // tier-based race: higher tier = better win chance, but RNG keeps it interesting
        int myTier    = getBestTier(username);
        int theirTier = getBestTier(challenger);
        // base win chance 50%, +5% per tier advantage, capped at 80%
        int tierDiff  = myTier - theirTier;
        int myChance  = 50 + (tierDiff * 5);
        if (myChance < 20) myChance = 20;
        if (myChance > 80) myChance = 80;

        srand((unsigned int)time(nullptr) ^ (unsigned int)(uintptr_t)&challenger);
        int roll = rand() % 100;
        bool iWin = roll < myChance;

        memSet("racepending_" + username, "");

        // find best car names for flavour
        std::string myBestCar = myGarage.back();
        std::string theirBestCar = theirGarage.back();
        for (auto& cd : carList) {
            for (auto& g : myGarage) if (g == cd.name) myBestCar = cd.name;
        }
        for (auto& cd : carList) {
            for (auto& g : theirGarage) if (g == cd.name) theirBestCar = cd.name;
        }

        sendToChat("\xF0\x9F\x9A\xA6 RACE: @" + challenger + " (" + theirBestCar + ") vs @" + username + " (" + myBestCar + ") — $" + std::to_string(bet) + " on the line!");
        Sleep(2000);

        if (iWin) {
            setCash(username, myCash + bet);
            setCash(challenger, theirCash - bet);
            sendToChat("\xF0\x9F\x8F\x81 @" + username + " wins! +$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(myCash + bet) + " | @" + challenger + " \xF0\x9F\x92\xB5 $" + std::to_string(theirCash - bet));
        } else {
            setCash(challenger, theirCash + bet);
            setCash(username, myCash - bet);
            sendToChat("\xF0\x9F\x8F\x81 @" + challenger + " wins! +$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(theirCash + bet) + " | @" + username + " \xF0\x9F\x92\xB5 $" + std::to_string(myCash - bet));
        }
        return;
    }

    // ---- DECLINE ----
    if (sub == "decline") {
        std::string pending = memGet("racepending_" + username);
        if (pending.empty()) {
            sendToChat("@" + username + " no pending race challenge.");
            return;
        }
        std::istringstream ps(pending);
        std::string challenger;
        std::getline(ps, challenger, ':');
        memSet("racepending_" + username, "");
        sendToChat("@" + username + " declined the race from @" + challenger + ".");
        return;
    }

    // ---- HELP ----
    sendToChat("@" + username + " \xF0\x9F\x9A\x97 !car dealership | price <car> | buy <car> | garage [@user] | sell <car> | race @user <bet>");
}